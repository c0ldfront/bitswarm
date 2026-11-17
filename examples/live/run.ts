import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { identity, assert, digest, type Manifest } from "../../src/core.ts";
import { Store } from "../../src/store.ts";
import { control } from "../../src/control.ts";
import { serve, sync } from "../../src/network.ts";
import { planFile } from "../../src/artifacts.ts";
import { runAutomation, type Automation } from "../../src/autopilot.ts";
import { verifyResult } from "../../src/verification.ts";
import { materializeFiles } from "../../src/runtime.ts";
const directory = mkdtempSync(join(tmpdir(), "bitswarm-live-"));
const output = resolve(
  process.env.BITSWARM_BASELINE === "1"
    ? "artifacts/live-baseline"
    : "artifacts/live",
);
mkdirSync(output, { recursive: true });
const planner = identity();
const target = planFile("/usr/bin/basename");
const manifest: Manifest = {
  version: 3,
  name: "GNU basename live reconstruction",
  description:
    "Investigate an installed native utility and reconstruct its unbounded path-processing behavior using real model inference, independent executable checks and automated project governance.",
  validators: [planner.publicKey],
  planner: planner.publicKey,
  quorum: 1,
  policy: { maxTokens: 1200000, maxCostMicros: 0, reviewTimeoutMs: 600000 },
  blocks: [
    {
      id: "discover",
      title: "Investigate GNU basename and plan reconstruction",
      instructions:
        "Investigate GNU basename through run_tool target. Read --help and probe empty paths, trailing slashes, /, suffix removal, -a, -s, -z and combined options. Return artifact {spec:string,instructions:string}: a concise observed specification and detailed instructions for another agent to write a general algorithmic CLI clone. Do not write implementation code. Cite probes in spec. Limit to five tool calls and then finish.",
      requires: [],
      inputs: [target.root],
      capabilities: ["planning"],
      contract: {
        timeoutMs: 180000,
        maxAttempts: 2,
        maxTokens: 300000,
        maxCostMicros: 0,
        verifier: "basename-parity",
        schema: {
          type: "object",
          properties: {
            spec: { type: "string" },
            instructions: { type: "string" },
          },
          required: ["spec", "instructions"],
          additionalProperties: true,
        },
      },
    },
  ],
};
const baseline = process.env.BITSWARM_BASELINE === "1";
if (baseline) {
  manifest.blocks = [
    {
      ...manifest.blocks[0],
      id: "implementation",
      title: "Reconstruct GNU basename directly",
      capabilities: ["coding"],
      instructions:
        "Investigate /usr/bin/basename through local commands and implement its general algorithmic path-processing behavior. Produce artifact.files[main.ts] as a portable Node.js TypeScript CLI (Node22.18+); handle -a/--multiple, -s/--suffix and --suffix=, -z/--zero, combined short options, -- separator, optional single-operand suffix, empty paths, trailing slashes, slash-only paths, errors, arbitrary Unicode strings. Match stdout and exit status. No external commands or dependencies in generated code; no lookup tables. Exact stderr wording, --help and --version are outside the contract.",
      contract: {
        ...manifest.blocks[0].contract!,
        maxAttempts: 3,
        schema: {
          type: "object",
          properties: {
            files: {
              type: "object",
              properties: { "main.ts": { type: "string" } },
              required: ["main.ts"],
              additionalProperties: false,
            },
          },
          required: ["files"],
          additionalProperties: true,
        },
      },
    },
  ];
}
const owner = new Store(join(directory, "owner"), manifest);
owner.who = planner;
const workers = (
  baseline ? ["single-agent"] : ["planner-agent", "coding-agent"]
).map((name) => new Store(join(directory, name), manifest));
const token = crypto.randomUUID();
process.env.BITSWARM_TOKEN = token;
for (const w of workers)
  control(owner, {
    type: "member",
    key: w.who.publicKey,
    role: "worker",
    enabled: true,
    budget: { maxTokens: 600000, maxCostMicros: 0, maxConcurrent: 1 },
  });
target.seed((bytes, id) => owner.addBlob(bytes, id));
const server = serve(owner, token, 0);
const url = server.url.toString();
const adapter = ["bun", resolve("examples/live/adapter.ts")];
const verifier = ["bun", resolve("examples/live/verifier.ts")];
const stop = new AbortController();
const started = Date.now();
const ownerConfig: Automation = {
  planner: {
    maxBlocks: 3,
    capabilities: ["coding"],
    verifiers: ["basename-parity"],
    checkpoint: true,
  },
  reviewer: { verifiers: { "basename-parity": verifier }, autoApprove: true },
  pollMs: 250,
  deadlineMs: 900000,
  stopWhenComplete: true,
  goalBlocks: ["implementation"],
};
try {
  for (const w of workers) await sync(w, url, token);
  const workerJobs = workers.map((w, i) =>
    runAutomation(
      w,
      {
        peers: [url],
        worker: {
          command: adapter,
          capabilities: [baseline ? "coding" : i ? "coding" : "planning"],
          ttlMs: 180000,
        },
        pollMs: 500,
        deadlineMs: 900000,
      },
      stop.signal,
    ).catch((e) => ({ stopped: String(e) })),
  );
  try {
    await runAutomation(owner, ownerConfig, stop.signal);
  } finally {
    stop.abort();
    await Promise.all(workerJobs);
  }
  const result = owner
    .state()
    .find((s) => s.block.id === "implementation")?.accepted;
  assert(result?.payload.kind === "result", "No accepted reconstruction");
  const artifact = JSON.parse(
    Buffer.from(owner.blob(result.payload.artifact)!).toString(),
  );
  const sourceDir = join(output, result.payload.artifact.slice(0, 12));
  mkdirSync(sourceDir, { recursive: true });
  materializeFiles(sourceDir, artifact.files);
  const holdout = await verifyResult(owner, result.id, [
    ...verifier,
    "--holdout",
    "92741",
  ]);
  assert(holdout.payload.kind === "verification", "Missing holdout");
  const report = JSON.parse(
    Buffer.from(owner.blob(holdout.payload.report)!).toString(),
  );
  const evidence = {
    baseline,
    format: "bitswarm.live-evaluation.v1",
    model:
      process.env.BITSWARM_LLM_DRIVER === "ollama"
        ? process.env.BITSWARM_LLM_MODEL || "qwen2.5-coder:7b"
        : "Codex authenticated CLI default",
    endpoint:
      process.env.BITSWARM_LLM_DRIVER === "ollama"
        ? "local loopback Ollama"
        : "Codex native authenticated transport",
    target: "/usr/bin/basename",
    targetHash: target.root,
    elapsedMs: Date.now() - started,
    sourceDir,
    billing:
      "Unpriced Codex account usage; failures are conservatively charged their reserved task budget, not reported as actual billed tokens.",
    passed: holdout.payload.passed,
    holdoutChecks: report.checks.checks.length,
    accounts: workers.map((w) => ({
      role: w.directory.split("/").at(-1),
      usage: w.usage(),
    })),
    states: owner.state().map((s) => ({
      id: s.block.id,
      status: s.status,
      attempts: owner
        .events()
        .filter(
          (e) => e.payload.kind === "claim" && e.payload.block === s.block.id,
        ).length,
    })),
    scope:
      "Unbounded path-processing clone. stderr wording, --help, --version and external file inputs are outside the specified contract.",
  };
  writeFileSync(join(output, "report.json"), JSON.stringify(evidence, null, 2));
  writeFileSync(
    join(output, "proof.json"),
    JSON.stringify(
      {
        manifest,
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
  writeFileSync(join(output, "holdout.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  assert(holdout.payload.passed, "Independent held-out cases failed");
} catch (e) {
  writeFileSync(
    join(output, "failure.json"),
    JSON.stringify(
      {
        error: String(e),
        states: owner.state(),
        automation: owner.db.query("SELECT * FROM automation").all(),
        events: owner.events(),
        diagnostics: workers.flatMap((w) => {
          const dir = join(w.directory, "failures");
          try {
            return readdirSync(dir).map((name) => ({
              role: w.directory.split("/").at(-1),
              diagnostic: readFileSync(join(dir, name), "utf8"),
            }));
          } catch {
            return [];
          }
        }),
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
  throw e;
} finally {
  stop.abort();
  server.stop(true);
  owner.close();
  workers.forEach((w) => w.close());
  rmSync(directory, { recursive: true, force: true });
}
