import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  identity,
  hash,
  type Manifest,
  type Block,
  makeEvent,
} from "../../src/core.ts";
import { Store } from "../../src/store.ts";
import { serve, sync } from "../../src/network.ts";
import { runWorker } from "../../src/worker.ts";
import { verifyResult } from "../../src/verification.ts";
import { control } from "../../src/control.ts";
import { checks, parameters, parts, samples } from "./oracle.ts";
import type { Format } from "./codec.ts";
const descriptions = {
  header:
    'Four bytes hold two unsigned 16-bit dimensions. Infer endian ("LE" or "BE") and heightFirst (boolean). Return {header:{endian,heightFirst}}.',
  palette:
    "Three stored RGB channels have a fixed permutation and each byte is XORed with the same mask. Infer order (stored channel names, e.g. BGR) and xor (integer). Return {palette:{order,xor}}.",
  runs: "Two bytes per run hold palette index and encoded count. Infer indexFirst (boolean) and bias (decoded count = stored count + bias). Return {runs:{indexFirst,bias}}.",
};
const budget = 90000;
async function measure(trial: number, mode: "single" | "swarm") {
  const root = mkdtempSync(join(tmpdir(), "bitswarm-image-"));
  const planner = identity(),
    fmt = parameters(trial),
    token = crypto.randomUUID();
  process.env.BITSWARM_TOKEN = token;
  const blobs = parts.map((part) =>
    Buffer.from(JSON.stringify({ part, samples: samples(part, fmt, 0, 5) })),
  );
  const blocks: Block[] = (mode === "single" ? ["image" as const] : parts).map(
    (id) => ({
      id,
      title: id,
      instructions:
        id === "image"
          ? Object.values(descriptions).join(" ") +
            " Combine all three objects in one JSON object."
          : descriptions[id],
      requires: [],
      capabilities: [id],
      inputs:
        id === "image"
          ? blobs.map((b) => hash(b))
          : [hash(blobs[parts.indexOf(id)])],
      contract: {
        timeoutMs: 180000,
        maxTokens: mode === "single" ? budget : budget / 3,
        maxCostMicros: 0,
        maxAttempts: 1,
        verifier: "compat",
      },
    }),
  );
  const manifest: Manifest = {
    version: 4,
    name: "Image compatibility pilot",
    description: "Infer a decoder profile from byte observations",
    planner: planner.publicKey,
    validators: [planner.publicKey],
    quorum: 1,
    policy: { maxTokens: budget },
    blocks,
  };
  const owner = new Store(join(root, "owner"), manifest);
  owner.who = planner;
  const workers = blocks.map((b) => new Store(join(root, b.id), manifest));
  const server = serve(owner, token, 0);
  const errors: string[] = [],
    receipts: {
      block: string;
      tokens: number;
      checks: number;
      elapsedMs: number;
    }[] = [];
  const candidate: Partial<Format> = {};
  let started = Date.now();
  try {
    for (const b of blobs) owner.addBlob(b);
    for (const [i, w] of workers.entries()) {
      control(owner, {
        type: "member",
        key: w.who.publicKey,
        role: "worker",
        enabled: true,
        budget: {
          maxTokens: blocks[i].contract!.maxTokens,
          maxCostMicros: 0,
          maxConcurrent: 1,
        },
      });
      w.configure({ download: "tasks", upload: "results" });
      w.rememberPeer(server.url.origin);
    }
    started = Date.now();
    await Promise.all(
      workers.map(async (w, i) => {
        try {
          await sync(w, server.url.origin, token);
          const event = await runWorker(
            w,
            ["bun", resolve("examples/compatibility/adapter.ts")],
            [blocks[i].id],
            180000,
          );
          if (event?.payload.kind !== "result")
            throw Error("Worker did not publish a result");
          await sync(w, server.url.origin, token);
          const att = await verifyResult(owner, event.id, [
            "bun",
            resolve("examples/compatibility/verifier.ts"),
            String(trial),
          ]);
          if (att.payload.kind !== "verification" || !att.payload.passed)
            throw Error("Verifier rejected " + blocks[i].id);
          owner.addEvent(
            makeEvent(manifest, planner, {
              kind: "review",
              result: event.id,
              verdict: "approve",
              reason: "Independent compatibility checks passed",
            }),
          );
          const artifact = JSON.parse(
            Buffer.from(owner.blob(event.payload.artifact)!).toString(),
          );
          for (const part of parts)
            if (
              (blocks[i].id === "image" || blocks[i].id === part) &&
              artifact[part]
            )
              candidate[part] = artifact[part];
          receipts.push({
            block: blocks[i].id,
            tokens: event.payload.usage!.tokens,
            checks: 32,
            elapsedMs: Date.now() - started,
          });
        } catch (error) {
          errors.push(blocks[i].id + ": " + String(error));
          console.error(errors.at(-1));
        }
      }),
    );
    const integrated = checks("image", candidate as Format, fmt);
    const attempts = workers.flatMap((w) =>
      w
        .events()
        .filter(
          (e) =>
            e.author === w.who.publicKey &&
            ["result", "failure"].includes(e.payload.kind),
        ),
    );
    const unknown = attempts.filter((e) => e.payload.kind === "failure").length;
    const reported = attempts.reduce(
      (n, e) =>
        n + (e.payload.kind === "result" ? (e.payload.usage?.tokens ?? 0) : 0),
      0,
    );
    return {
      trial,
      mode,
      projectTokenBudget: budget,
      elapsedMs: Date.now() - started,
      firstVerifiedMs: receipts.length
        ? Math.min(...receipts.map((r) => r.elapsedMs))
        : null,
      workerPayloadBytes: workers.map((w) => w.usedBytes("download")),
      reportedTokens: reported,
      unreportedFailedAttempts: unknown,
      totalTokensIncludingRetries: unknown ? null : reported,
      receipts,
      integratedPassed: integrated.filter(Boolean).length,
      integratedCases: integrated.length,
      errors,
    };
  } finally {
    server.stop(true);
    for (const w of workers) w.close();
    owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const output = resolve(
  process.env.BITSWARM_PILOT_OUTPUT || "artifacts/compatibility/report.json",
);
mkdirSync(resolve(output, ".."), { recursive: true });
const rows = [];
for (const trial of [1, 2])
  for (const mode of (trial === 1
    ? ["single", "swarm"]
    : ["swarm", "single"]) as ("single" | "swarm")[]) {
    console.log("Running", trial, mode);
    rows.push(await measure(trial, mode));
    writeFileSync(
      output,
      JSON.stringify(
        {
          format: "bitswarm.compatibility.v1",
          driver: "native Codex",
          scope:
            "Single-host synthetic image codec. Same observations and parameterized decoder in each paired trial. Fixed one-attempt policy. Timings include artifact fetch, model execution, verification and assembly.",
          rows,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify(rows.at(-1)));
  }
if (
  rows.some((r) => r.errors.length || r.integratedPassed !== r.integratedCases)
)
  process.exitCode = 1;
