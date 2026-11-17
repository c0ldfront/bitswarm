import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assert,
  canonical,
  digest,
  identity,
  makeEvent,
  type Manifest,
} from "../src/core.ts";
import { control, propose } from "../src/control.ts";
import { Store } from "../src/store.ts";
import { serve, sync } from "../src/network.ts";
import { chunkFile } from "../src/artifacts.ts";
import { runWorker } from "../src/worker.ts";
import { verifyResult } from "../src/verification.ts";
import { materializeFiles } from "../src/runtime.ts";
const directory = mkdtempSync(join(tmpdir(), "bitswarm-benchmark-"));
const output = resolve(
  process.env.BITSWARM_BENCHMARK_OUTPUT || "artifacts/benchmark",
);
mkdirSync(output, { recursive: true });
const token = crypto.randomUUID();
const planner = identity();
execFileSync("cc", [
  "-O2",
  "-s",
  "examples/reconstruction/target.c",
  "-o",
  join(directory, "target"),
]);
const target = chunkFile(join(directory, "target"));
const schema = {
  type: "object",
  properties: {
    files: { type: "object", additionalProperties: { type: "string" } },
    evidence: { type: "object" },
    mode: { type: "string" },
    observed: { type: "array", items: { type: "integer" } },
  },
  required: ["files", "evidence"],
  additionalProperties: false,
};
const contract = {
  timeoutMs: 120_000,
  maxAttempts: 3,
  maxTokens: 0,
  maxCostMicros: 0,
  verifier: "parity",
  schema,
};
const manifest: Manifest = {
  version: 2,
  name: "Finite CLI reconstruction",
  description:
    "Reconstruct a compiled executable through observed behavior. Exhaustively verify the declared finite input domain.",
  validators: [planner.publicKey],
  planner: planner.publicKey,
  quorum: 1,
  policy: {
    reviewTimeoutMs: 60_000,
    maxConcurrent: 3,
    maxTokens: 0,
    maxCostMicros: 0,
  },
  blocks: ["mix", "score", "route"].map((id) => ({
    id,
    title: "Recover " + id,
    instructions: `Probe ${id} for all integer inputs 0..63. Generate a TypeScript module from observations and cite the source hash.`,
    requires: [],
    inputs: target.objects.map((o) => o.id),
    capabilities: ["probe"],
    contract,
  })),
};
const adapter = resolve("examples/reconstruction/adapter.ts"),
  verifier = resolve("examples/reconstruction/verifier.ts");
async function experiment(parallel: boolean) {
  const runDir = join(directory, parallel ? "swarm" : "single");
  const owner = new Store(join(runDir, "planner"), manifest);
  owner.who = planner;
  const workers = Array.from(
    { length: parallel ? 3 : 1 },
    (_, i) => new Store(join(runDir, "worker-" + i), manifest),
  );
  const server = serve(owner, token, 0);
  target.objects.forEach((o) => owner.addBlob(o.data, o.id));
  const started = performance.now();
  const results: string[] = [];
  try {
    // The planner admits an integration task at runtime, preserving the swarm ID.
    const proposal = propose(
      owner,
      {
        id: "assemble",
        title: "Assemble reconstructed application",
        instructions:
          "Merge accepted modules and implement the command dispatch contract. Return the complete source file set.",
        requires: ["mix", "score", "route"],
        inputs: [target.root],
        capabilities: ["integrate"],
        contract,
      },
      "Integrate independently observed subsystems",
    );
    control(owner, { type: "add", proposal: proposal.id });
    for (const worker of workers)
      await sync(worker, server.url.toString(), token);
    if (parallel)
      for (let i = 0; i < workers.length; i++)
        workers[i].select([["mix", "score", "route"][i], "assemble"]);
    // Claim propagation makes independent workers choose different ready blocks.
    const running: Promise<any>[] = [];
    for (let i = 0; i < 3; i++) {
      const worker = workers[i % workers.length];
      const job = runWorker(
        worker,
        ["bun", adapter],
        ["probe", "integrate"],
        120_000,
      );
      running.push(job);
      if (parallel) {
        await sync(worker, server.url.toString(), token);
        for (const other of workers)
          if (other !== worker) await sync(other, server.url.toString(), token);
      } else {
        await job;
        await sync(worker, server.url.toString(), token);
      }
    }
    const recovered = await Promise.all(running);
    for (const e of recovered) {
      assert(e?.payload.kind === "result", "Expected subsystem result");
      results.push(e.id);
    }
    for (const worker of workers)
      await sync(worker, server.url.toString(), token);
    async function accept(id: string) {
      const verification = await verifyResult(owner, id, ["bun", verifier]);
      if (
        verification.payload.kind === "verification" &&
        !verification.payload.passed
      ) {
        const result = owner.event(id)!;
        writeFileSync(
          join(
            output,
            "failed-" +
              (result.payload.kind === "result"
                ? result.payload.block
                : "unknown") +
              ".json",
          ),
          owner.blob(verification.payload.report)!,
        );
      }
      assert(
        verification.payload.kind === "verification" &&
          verification.payload.passed,
        "Parity verification failed",
      );
      owner.addEvent(
        makeEvent(manifest, owner.who, {
          kind: "review",
          result: id,
          verdict: "approve",
          reason:
            "Independent exhaustive native-executable parity checks passed",
        }),
      );
    }
    for (const id of results) await accept(id);
    control(owner, {
      type: "checkpoint",
      results: owner
        .state()
        .flatMap((s) => (s.accepted ? [s.accepted.id] : [])),
      evidence: owner.events().map((e) => e.id),
    });
    const integrator = workers[0];
    integrator.select(["assemble"]);
    await sync(integrator, server.url.toString(), token);
    const integrated = await runWorker(
      integrator,
      ["bun", adapter],
      ["probe", "integrate"],
      120_000,
    );
    assert(integrated?.payload.kind === "result", "Integration failed");
    await sync(integrator, server.url.toString(), token);
    await accept(integrated.id);
    control(owner, {
      type: "checkpoint",
      results: owner
        .state()
        .flatMap((s) => (s.accepted ? [s.accepted.id] : [])),
      evidence: owner.events().map((e) => e.id),
    });
    assert(
      owner.state().every((s) => s.status === "accepted"),
      "Incomplete reconstruction",
    );
    const artifact = JSON.parse(
      Buffer.from(owner.blob(integrated.payload.artifact)!).toString(),
    );
    const destination = join(
      output,
      (parallel ? "swarm-" : "single-") +
        integrated.payload.artifact.slice(0, 12),
    );
    mkdirSync(destination, { recursive: true });
    materializeFiles(destination, artifact.files);
    writeFileSync(
      join(output, parallel ? "swarm-proof.json" : "single-proof.json"),
      JSON.stringify(
        {
          manifest: owner.manifest,
          events: owner.events(),
          objects: Object.fromEntries(
            owner
              .inventory()
              .blobs.map((id) => [
                id,
                Buffer.from(owner.blob(id)!).toString("base64"),
              ]),
          ),
        },
        null,
        2,
      ),
    );
    const report = {
      mode: parallel ? "three-worker swarm" : "single-worker baseline",
      elapsedMs: Math.round(performance.now() - started),
      swarm: digest(manifest),
      acceptedBlocks: owner.state().length,
      validInputParityCases: 192,
      boundaryParityCases: 13,
      totalVerifierChecks: 397,
      usage: workers.map((w) => w.usage()),
      metrics: owner.metrics(),
      artifact: integrated.payload.artifact,
      generatedPath: destination,
      method:
        "Deterministic black-box enumeration; no LLM inference or model spending",
      conclusions:
        "Finite-domain reconstruction only. Results do not establish performance on arbitrary applications or LLM quality.",
    };
    writeFileSync(
      join(output, parallel ? "swarm.json" : "single.json"),
      JSON.stringify(report, null, 2),
    );
    return report;
  } finally {
    server.stop(true);
    owner.close();
    workers.forEach((w) => w.close());
  }
}
try {
  const single = await experiment(false),
    swarm = await experiment(true);
  const report = { single, swarm, speedup: single.elapsedMs / swarm.elapsedMs };
  writeFileSync(
    join(output, "comparison.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
