import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, makeEvent, digest, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { control } from "../src/control.ts";
import { claim, submit, runWorker } from "../src/worker.ts";
import { execute } from "../src/runtime.ts";
function setup() {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-repairs-"));
  const planner = identity(),
    worker = identity();
  const manifest: Manifest = {
    version: 2,
    name: "Repair regression",
    description: "Adversarial lifecycle checks",
    planner: planner.publicKey,
    validators: [planner.publicKey],
    quorum: 1,
    policy: { maxTokens: 100 },
    blocks: ["a", "b"].map((id) => ({
      id,
      title: id,
      instructions: "Work",
      requires: [],
      inputs: [],
      capabilities: [],
      contract: {
        timeoutMs: 10000,
        maxAttempts: 3,
        maxTokens: 60,
        maxCostMicros: 0,
      },
    })),
  };
  const store = new Store(path, manifest);
  return {
    store,
    manifest,
    planner,
    worker,
    cleanup: () => {
      store.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}
test("legacy planner expenditure and in-flight reservations cannot be allocated again", () => {
  const f = setup();
  try {
    f.store.who = f.planner;
    const lease = makeEvent(f.manifest, f.planner, {
      kind: "claim",
      block: "a",
      epoch: digest(f.manifest),
      expires: Date.now() + 10000,
      dependencies: [],
    });
    f.store.addEvent(lease);
    expect(() =>
      control(f.store, {
        type: "member",
        key: f.worker.publicKey,
        role: "worker",
        enabled: true,
        budget: { maxTokens: 60, maxCostMicros: 0, maxConcurrent: 1 },
      }),
    ).toThrow("budget");
    submit(f.store, lease.id, Buffer.from("{}"), "Consumed 60", {
      tokens: 60,
      costMicros: 0,
    });
    expect(() =>
      control(f.store, {
        type: "member",
        key: f.worker.publicKey,
        role: "worker",
        enabled: true,
        budget: { maxTokens: 60, maxCostMicros: 0, maxConcurrent: 1 },
      }),
    ).toThrow("budget");
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: true,
      budget: { maxTokens: 40, maxCostMicros: 0, maxConcurrent: 1 },
    });
    f.store.who = f.worker;
    expect(() => claim(f.store, "b")).toThrow("budget");
  } finally {
    f.cleanup();
  }
});
test("cancellation terminates a running adapter and prevents late publication", async () => {
  const f = setup();
  try {
    f.store.who = f.planner;
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: true,
      budget: { maxTokens: 100, maxCostMicros: 0, maxConcurrent: 1 },
    });
    f.store.who = f.worker;
    const started = Date.now();
    const running = runWorker(
      f.store,
      [
        "bun",
        "-e",
        'await new Promise(r=>setTimeout(r,9000));console.log(JSON.stringify({summary:"late",artifact:{}}))',
      ],
      [],
      10000,
    ).then(
      () => false,
      () => true,
    );
    await Bun.sleep(100);
    f.store.who = f.planner;
    control(f.store, { type: "cancel", block: "a" });
    f.store.who = f.worker;
    expect(await running).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f.store.events().some((e) => e.payload.kind === "result")).toBe(
      false,
    );
  } finally {
    f.cleanup();
  }
});
test("invalid follow-up batches fail before a result is published", async () => {
  const f = setup();
  try {
    f.store.who = f.planner;
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: true,
      budget: { maxTokens: 100, maxCostMicros: 0, maxConcurrent: 1 },
    });
    f.store.who = f.worker;
    await expect(
      runWorker(
        f.store,
        [
          "bun",
          "-e",
          'console.log(JSON.stringify({summary:"too many",artifact:{},proposals:Array(9).fill({})}))',
        ],
        [],
        10000,
      ),
    ).rejects.toThrow("At most 8");
    expect(f.store.events().some((e) => e.payload.kind === "result")).toBe(
      false,
    );
    expect(
      f.store.events().filter((e) => e.payload.kind === "failure"),
    ).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
const integration =
  process.env.BITSWARM_TEST_ISOLATION === "1" ? test : test.skip;
integration(
  "Docker resolves Bun inside its image instead of using the host path",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bitswarm-docker-bun-"));
    try {
      const r = await execute({
        command: ["bun", "-e", 'console.log("container-bun-ok")'],
        input: {},
        cwd: dir,
        isolation: "docker",
        image: "oven/bun:1.4.2",
        timeoutMs: 10000,
      });
      expect(r.stdout.trim()).toBe("container-bun-ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
integration(
  "whole Bun adapter isolation mounts only job files and supports bundled code",
  async () => {
    const { writeFileSync } = await import("node:fs");
    const path = mkdtempSync(join(tmpdir(), "bitswarm-isolated-job-"));
    const owner = identity();
    const m: Manifest = {
      version: 2,
      name: "Isolated worker",
      description: "Workspace mounting regression",
      validators: [owner.publicKey],
      quorum: 1,
      blocks: [
        {
          id: "x",
          title: "X",
          instructions: "Inspect",
          requires: [],
          inputs: [],
          capabilities: [],
        },
      ],
    };
    const store = new Store(path, m);
    try {
      const script = join(path, "adapter.ts");
      writeFileSync(
        script,
        'import{existsSync}from"node:fs";const i=JSON.parse(await Bun.stdin.text());if(existsSync("/home/coldfront/.codex"))throw Error("home leaked");console.log(JSON.stringify({summary:"isolated",artifact:{workspace:i.workspace,files:i.files}}));',
      );
      const result = await runWorker(store, ["bun", script], [], 10000, {
        isolation: "bwrap",
      });
      expect(result?.payload.kind).toBe("result");
      if (result?.payload.kind === "result")
        expect(
          JSON.parse(
            Buffer.from(store.blob(result.payload.artifact)!).toString(),
          ).workspace,
        ).toBe("/work");
    } finally {
      store.close();
      rmSync(path, { recursive: true, force: true });
    }
  },
);
test("cancellation also reaps detached descendants of a trusted local adapter", async () => {
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-descendants-"));
  const marker = join(dir, "pid");
  const stop = new AbortController();
  try {
    const running = execute({
      command: [
        "bun",
        "-e",
        'const c=Bun.spawn(["sleep","30"],{detached:true});await Bun.write(' +
          JSON.stringify(marker) +
          ",String(c.pid));await new Promise(()=>{});",
      ],
      input: {},
      cwd: dir,
      timeoutMs: 5000,
      signal: stop.signal,
    }).catch((e) => e);
    for (let n = 0; n < 100 && !existsSync(marker); n++) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true);
    await Bun.sleep(100);
    const pid = Number(readFileSync(marker, "utf8"));
    stop.abort();
    await running;
    await Bun.sleep(30);
    let alive = false;
    try {
      const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
      alive = !stat.split(") ")[1].startsWith("Z");
    } catch {}
    expect(alive).toBe(false);
  } finally {
    stop.abort();
    rmSync(dir, { recursive: true, force: true });
  }
});
integration(
  "a complete bundled Bun worker runs through the Docker adapter path",
  async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "bitswarm-docker-worker-"));
    const owner = identity();
    const m: Manifest = {
      version: 3,
      name: "Docker worker",
      description: "Actual mounted adapter lifecycle",
      validators: [owner.publicKey],
      quorum: 1,
      blocks: [
        {
          id: "x",
          title: "X",
          instructions: "Inspect",
          requires: [],
          inputs: [],
          capabilities: [],
        },
      ],
    };
    const s = new Store(dir, m);
    try {
      const script = join(dir, "adapter.ts");
      writeFileSync(
        script,
        'const i=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({summary:"container worker",artifact:{workspace:i.workspace}}));',
      );
      const e = await runWorker(s, ["bun", script], [], 10000, {
        isolation: "docker",
        image: "oven/bun:1.4.2",
      });
      expect(e?.payload.kind).toBe("result");
      if (e?.payload.kind === "result")
        expect(
          JSON.parse(Buffer.from(s.blob(e.payload.artifact)!).toString())
            .workspace,
        ).toBe("/work");
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
