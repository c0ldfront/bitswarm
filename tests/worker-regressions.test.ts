import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import {
  claim,
  packet,
  prepareTask,
  requestInput,
  runWorker,
  submit,
} from "../src/worker.ts";
import {
  digest,
  hash,
  identity,
  makeEvent,
  type Manifest,
} from "../src/core.ts";
import { control } from "../src/control.ts";

function setup(tokenLimits = [100], optionalInputs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-worker-regression-"));
  const planner = identity(),
    worker = identity();
  const manifest: Manifest = {
    version: 4,
    name: "Leases",
    description: "Worker regressions",
    planner: planner.publicKey,
    validators: [planner.publicKey],
    quorum: 1,
    blocks: tokenLimits.map((maxTokens, i) => ({
      id: "task" + i,
      title: "Task " + i,
      instructions: "Describe",
      requires: [],
      inputs: [],
      ...(i === 0 && optionalInputs.length ? { optionalInputs } : {}),
      capabilities: [],
      contract: {
        maxTokens,
        maxCostMicros: 0,
        maxAttempts: 2,
        timeoutMs: 10_000,
      },
    })),
  };
  const store = new Store(dir, manifest);
  store.who = worker;
  return {
    store,
    planner,
    worker,
    manifest,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("manual claims wait for requested input chunks while other tasks can still run", async () => {
  const chunk = Buffer.from("optional source bytes");
  const index = Buffer.from(
    JSON.stringify({ type: "bitswarm.file.v1", chunks: [hash(chunk)] }),
  );
  const root = hash(index);
  const f = setup([0, 0], [root]);
  try {
    f.store.configure({ download: "tasks", upload: "results" });
    f.store.addBlob(index);
    requestInput(f.store, "task0", root, "Need source");
    await prepareTask(f.store, "task0");
    expect(() => claim(f.store, "task0")).toThrow("input");
    expect(f.store.events().some((e) => e.payload.kind === "claim")).toBe(
      false,
    );
    const result = await runWorker(f.store, [
      "bun",
      "-e",
      'console.log(JSON.stringify({summary:"Done",artifact:{}}))',
    ]);
    expect(result?.payload.kind === "result" && result.payload.block).toBe(
      "task1",
    );
    f.store.addBlob(chunk);
    expect(claim(f.store, "task0").payload.kind).toBe("claim");
  } finally {
    f.close();
  }
});
test("repeated publication of one lease returns the original receipt and rejects changed artifacts", () => {
  const f = setup();
  try {
    const lease = claim(f.store, "task0"),
      a = Buffer.from('{"bytes":1}');
    const first = submit(f.store, lease.id, a, "Finished");
    expect(submit(f.store, lease.id, a, "Finished").id).toBe(first.id);
    expect(() =>
      submit(f.store, lease.id, Buffer.from('{"bytes":2}'), "Changed"),
    ).toThrow();
    expect(
      f.store.events().filter((e) => e.payload.kind === "result"),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});
test("a failed lease remains closed even after another worker claim", () => {
  const f = setup();
  try {
    const first = claim(f.store, "task0");
    f.store.addEvent(
      makeEvent(f.manifest, f.worker, {
        kind: "failure",
        claim: first.id,
        retryable: true,
        reason: "No answer",
      }),
    );
    const retry = claim(f.store, "task0");
    expect(() =>
      submit(f.store, first.id, Buffer.from("{}"), "Late answer"),
    ).toThrow();
    expect(
      submit(f.store, retry.id, Buffer.from("{}"), "Current").payload.kind,
    ).toBe("result");
  } finally {
    f.close();
  }
});
test("a pending owner fork prevents a local worker from publishing a result", () => {
  const f = setup();
  try {
    const lease = claim(f.store, "task0"),
      parent = digest(f.manifest);
    for (const maxConcurrent of [1, 2])
      f.store.addEvent(
        makeEvent(f.manifest, f.planner, {
          kind: "control",
          parent,
          action: { type: "policy", policy: { maxConcurrent } },
        }),
      );
    expect(f.store.governance().conflict).toBe(true);
    expect(() =>
      submit(f.store, lease.id, Buffer.from("{}"), "Forked"),
    ).toThrow();
    expect(f.store.events().some((e) => e.payload.kind === "result")).toBe(
      false,
    );
  } finally {
    f.close();
  }
});
test("worker schedules affordable work behind a task that exceeds its allocation", async () => {
  const f = setup([100, 5]);
  try {
    f.store.who = f.planner;
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: true,
      budget: { maxTokens: 10, maxCostMicros: 0, maxConcurrent: 1 },
    });
    f.store.who = f.worker;
    f.store.configure({ download: "tasks", upload: "results" });
    const e = await runWorker(f.store, [
      "bun",
      "-e",
      'console.log(JSON.stringify({summary:"Done",artifact:{},usage:{tokens:5,costMicros:0}}))',
    ]);
    expect(e?.payload.kind === "result" && e.payload.block).toBe("task1");
    expect(f.store.state()[0].claims.length).toBe(0);
    expect(f.store.subscriptions()).toEqual(["task1"]);
  } finally {
    f.close();
  }
});
test("a worker stopped before dispatch leaves the attempt and budget untouched", async () => {
  const f = setup();
  try {
    const stop = new AbortController();
    stop.abort(new Error("Stopped before dispatch"));
    await expect(
      runWorker(
        f.store,
        [
          "bun",
          "-e",
          'console.log(JSON.stringify({summary:"Done",artifact:{}}))',
        ],
        [],
        10_000,
        { signal: stop.signal },
      ),
    ).rejects.toThrow();
    expect(f.store.events()).toHaveLength(0);
  } finally {
    f.close();
  }
});
test("a budgeted adapter must report usage before it releases a reservation", async () => {
  const f = setup([100]);
  try {
    await expect(
      runWorker(f.store, [
        "bun",
        "-e",
        'console.log(JSON.stringify({summary:"Done",artifact:{}}))',
      ]),
    ).rejects.toThrow("usage");
    expect(f.store.usage().tokens).toBe(100);
    expect(f.store.events().some((e) => e.payload.kind === "result")).toBe(
      false,
    );
  } finally {
    f.close();
  }
});
test("a worker does not record a failure if an operator already submitted the same lease", async () => {
  const f = setup();
  try {
    const stopped = runWorker(f.store, [
      "bun",
      "-e",
      "await Bun.sleep(9000)",
    ]).catch((e) => e);
    for (let i = 0; i < 100 && !f.store.state()[0].claims.length; i++)
      await Bun.sleep(5);
    const lease = f.store.state()[0].claims[0];
    expect(lease).toBeDefined();
    submit(f.store, lease.id, Buffer.from("{}"), "Recovered by operator", {
      tokens: 8,
      costMicros: 0,
    });
    await stopped;
    expect(f.store.events().some((e) => e.payload.kind === "failure")).toBe(
      false,
    );
    expect(f.store.usage().tokens).toBe(8);
  } finally {
    f.close();
  }
});

test("a rejected attempt's unavailable verifier report cannot prevent retry dispatch", () => {
  const f = setup();
  try {
    const first = claim(f.store, "task0");
    const result = submit(
      f.store,
      first.id,
      Buffer.from("{}"),
      "Initial attempt",
    );
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "review",
        result: result.id,
        verdict: "reject",
        reason: "Incorrect answer",
      }),
    );
    const incomplete = f.store.addBlob(Buffer.from("Partial verifier output"));
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "verification",
        result: result.id,
        verifier: "old-config",
        passed: false,
        report: incomplete,
      }),
    );
    const second = claim(f.store, "task0");
    const previous = packet(f.store, second.id).previous;
    expect(previous).toEqual([
      { result: result.id, summary: "Initial attempt", reports: [] },
    ]);
  } finally {
    f.close();
  }
});
