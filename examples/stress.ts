import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  identity,
  makeEvent,
  type Manifest,
  assert,
  canonical,
} from "../src/core.ts";
import { Store } from "../src/store.ts";
import { serve, sync } from "../src/network.ts";
import { claim, submit } from "../src/worker.ts";
import { checkpoint } from "../src/control.ts";
import { compact } from "../src/operations.ts";
const duration = Number(process.env.BITSWARM_STRESS_SECONDS || 60) * 1000;
assert(
  duration >= 1000 && duration <= 3600000,
  "Stress duration must be 1–3600 seconds",
);
const path = mkdtempSync(join(tmpdir(), "bitswarm-stress-")),
  key = identity();
const m: Manifest = {
  version: 3,
  name: "Fault/load rehearsal",
  description:
    "Bounded multi-peer traffic with interrupted connectivity and accounting compaction",
  validators: [key.publicKey],
  quorum: 1,
  policy: { requestsPerMinute: 100000 },
  blocks: Array.from({ length: 180 }, (_, i) => ({
    id: "task" + i,
    title: "Task " + i,
    instructions: "Produce a reproducible local fixture",
    requires: [],
    inputs: [],
    capabilities: [],
  })),
};
const stores = ["owner", "a", "b", "c"].map((n) => new Store(join(path, n), m));
const [owner, ...workers] = stores;
owner.who = key;
const token = crypto.randomUUID();
let server = serve(owner, token, 0);
const start = Date.now();
let completed = 0,
  offlineRounds = 0,
  round = 0,
  restarts = 0,
  maxLag = 0,
  peakRss = 0;
try {
  while (Date.now() - start < duration) {
    const tick = Date.now();
    round++;
    const offline = round % 10 === 3 || round % 10 === 4;
    if (offline) {
      if (round % 10 === 3) {
        server.stop(true);
        restarts++;
      }
      offlineRounds++;
    } else if (round % 10 === 5) server = serve(owner, token, 0);
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      if (!offline) await sync(w, server.url.toString(), token);
      if (completed < m.blocks.length) {
        const id = "task" + completed;
        if (w.state().find((s) => s.block.id === id)?.status === "ready") {
          if (completed % 6 === 0) {
            const failed = claim(w, id);
            w.addEvent(
              makeEvent(m, w.who, {
                kind: "failure",
                claim: failed.id,
                reason: "Injected local attempt failure",
                retryable: true,
              }),
            );
          }
          const lease = claim(w, id);
          submit(
            w,
            lease.id,
            Buffer.from(
              JSON.stringify({ value: completed, payload: "x".repeat(2048) }),
            ),
            "Load fixture",
          );
          completed++;
        }
      }
      if (!offline) await sync(w, server.url.toString(), token);
    }
    for (const e of owner.events())
      if (
        e.payload.kind === "result" &&
        !owner
          .events()
          .some((r) => r.payload.kind === "review" && r.payload.result === e.id)
      )
        owner.addEvent(
          makeEvent(m, key, {
            kind: "review",
            result: e.id,
            verdict: "approve",
            reason: "Independent fixture acceptance",
          }),
        );
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    maxLag = Math.max(maxLag, Date.now() - tick);
    await Bun.sleep(50);
  }
  server.stop(true);
  server = serve(owner, token, 0);
  for (let n = 0; n < 3; n++)
    for (const w of workers) await sync(w, server.url.toString(), token);
  for (const e of owner.events())
    if (
      e.payload.kind === "result" &&
      !owner
        .events()
        .some((r) => r.payload.kind === "review" && r.payload.result === e.id)
    )
      owner.addEvent(
        makeEvent(m, key, {
          kind: "review",
          result: e.id,
          verdict: "approve",
          reason: "Post-partition fixture acceptance",
        }),
      );
  checkpoint(owner);
  const compacted = compact(owner);
  for (let n = 0; n < 3; n++)
    for (const w of workers) await sync(w, server.url.toString(), token);
  const expected = canonical(owner.inventory());
  assert(
    stores.every((s) => canonical(s.inventory()) === expected),
    "Replicas did not converge after healing",
  );
  const output = resolve("artifacts/validation-v3");
  mkdirSync(output, { recursive: true });
  const report = {
    protocol: m.version,
    bun: Bun.version,
    durationMs: Date.now() - start,
    rounds: round,
    completedTasks: completed,
    acceptedTasks: owner.state().filter((s) => s.status === "accepted").length,
    offlineRounds,
    serverRestarts: restarts,
    maxRoundMs: maxLag,
    peakRssBytes: peakRss,
    compaction: compacted,
    converged: true,
    limits:
      "Single-host rehearsal; not a public-internet capacity or Byzantine security claim",
  };
  writeFileSync(join(output, "stress.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.stop(true);
  stores.forEach((s) => s.close());
  rmSync(path, { recursive: true, force: true });
}
