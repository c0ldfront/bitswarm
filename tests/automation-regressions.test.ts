import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, hash, makeEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { control, propose } from "../src/control.ts";
import { claim, submit } from "../src/worker.ts";
import { runAutomation, automationStep } from "../src/autopilot.ts";
import { handle, serve, sync } from "../src/network.ts";

function fixture(inputs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-automation-regression-"));
  const owner = identity();
  const m: Manifest = {
    version: 4,
    name: "Lifecycle",
    description: "Test automation lifecycle",
    validators: [owner.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "goal",
        title: "Goal",
        instructions: "Work",
        requires: [],
        capabilities: [],
        inputs,
        contract: {
          timeoutMs: 5000,
          maxAttempts: 2,
          maxTokens: 0,
          maxCostMicros: 0,
          verifier: "check",
        },
      },
    ],
  };
  const store = new Store(join(dir, "state"), m);
  return {
    dir,
    owner,
    store,
    m,
    cleanup() {
      store.close();
      rmSync(dir, { force: true, recursive: true });
    },
  };
}
test("automation deadline cancels the adapter during its polling interval", async () => {
  const f = fixture();
  try {
    const started = Date.now();
    await expect(
      runAutomation(f.store, {
        pollMs: 2000,
        deadlineMs: 250,
        worker: {
          capabilities: [],
          command: [
            "bun",
            "-e",
            'await Bun.sleep(700);console.log(JSON.stringify({summary:"late result",artifact:{}}))',
          ],
        },
      }),
    ).rejects.toThrow("deadline");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(f.store.events().some((e) => e.payload.kind === "claim")).toBe(true);
    expect(f.store.events().some((e) => e.payload.kind === "result")).toBe(
      false,
    );
  } finally {
    f.cleanup();
  }
});
test("a cancelled required goal cannot be reported as successful", async () => {
  const f = fixture();
  f.store.who = f.owner;
  try {
    control(f.store, { type: "cancel", block: "goal" });
    await expect(
      runAutomation(f.store, { stopWhenComplete: true, goalBlocks: ["goal"] }),
    ).rejects.toThrow("goal block cancelled");
  } finally {
    f.cleanup();
  }
});
test("automatic review checks the configured recipe before reusing a cached attestation", async () => {
  const f = fixture();
  const verifier = [
    "bun",
    "-e",
    'console.log(JSON.stringify({passed:false,checks:[{name:"actual check",passed:false}]}))',
  ];
  try {
    const lease = claim(f.store, "goal");
    const result = submit(
      f.store,
      lease.id,
      Buffer.from("{}"),
      "ready for review",
    );
    f.store.who = f.owner;
    const report = f.store.addBlob(
      Buffer.from(
        JSON.stringify({
          protocol: "bitswarm.verification.v1",
          verifier: "check",
          result: result.id,
          recipe: "0".repeat(64),
          checks: {
            passed: true,
            checks: [{ name: "prior recipe", passed: true }],
          },
        }),
      ),
    );
    f.store.addEvent(
      makeEvent(f.m, f.owner, {
        kind: "verification",
        verifier: "check",
        result: result.id,
        report,
        passed: true,
      }),
    );
    await automationStep(f.store, {
      reviewer: {
        verifiers: { check: verifier },
        autoApprove: true,
        isolation: "process",
      },
    });
    expect(
      f.store
        .events()
        .filter((e) => e.payload.kind === "review")
        .map((e) => e.payload.kind === "review" && e.payload.verdict),
    ).toEqual(["reject"]);
  } finally {
    f.cleanup();
  }
});
test("planner waits for missing optional inputs and file chunks before admission", async () => {
  const f = fixture();
  f.store.who = f.owner;
  try {
    const chunk = Buffer.from("test input");
    const root = f.store.addBlob(
      Buffer.from(
        JSON.stringify({ type: "bitswarm.file.v1", chunks: [hash(chunk)] }),
      ),
    );
    const opt = Buffer.from("lookup table");
    propose(
      f.store,
      {
        ...f.m.blocks[0],
        id: "child",
        inputs: [root],
        optionalInputs: [hash(opt)],
      },
      "Offer an input table",
    );
    const config = {
      planner: { maxBlocks: 2, capabilities: [], verifiers: ["check"] },
    };
    await automationStep(f.store, config);
    expect(f.store.governance().manifest.blocks).toHaveLength(1);
    f.store.addBlob(chunk);
    await automationStep(f.store, config);
    expect(f.store.governance().manifest.blocks).toHaveLength(1);
    f.store.addBlob(opt);
    await automationStep(f.store, config);
    expect(f.store.governance().manifest.blocks).toHaveLength(2);
  } finally {
    f.cleanup();
  }
});
test("successful automation syncs the final checkpoint before the owner closes", async () => {
  const f = fixture(),
    peer = new Store(join(f.dir, "peer"), f.m);
  const token = "automation-regression-xxxxxxxxxxxxxxxxx",
    old = process.env.BITSWARM_TOKEN;
  const server = serve(peer, token, 0);
  process.env.BITSWARM_TOKEN = token;
  try {
    const result = submit(
      f.store,
      claim(f.store, "goal").id,
      Buffer.from("{}"),
      "ready",
    );
    f.store.who = f.owner;
    const verifier = [
      "bun",
      "-e",
      'console.log(JSON.stringify({passed:true,checks:[{name:"check",passed:true}]}))',
    ];
    await runAutomation(f.store, {
      peers: [server.url.origin],
      planner: {
        maxBlocks: 1,
        capabilities: [],
        verifiers: ["check"],
        checkpoint: true,
      },
      reviewer: {
        verifiers: { check: verifier },
        autoApprove: true,
        isolation: "process",
      },
      stopWhenComplete: true,
      goalBlocks: ["goal"],
      deadlineMs: 5000,
      pollMs: 2000,
    });
    expect(peer.governance().checkpoints?.get("goal")?.result).toBe(result.id);
  } finally {
    if (old === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = old;
    server.stop(true);
    peer.close();
    f.cleanup();
  }
});
test("a restarted actor resumes gossip with its join peer unless explicitly configured to run alone", async () => {
  const f = fixture();
  const peer = new Store(join(f.dir, "seed"), f.m);
  const token = "automation-restart-xxxxxxxxxxxxxxxxx";
  const old = process.env.BITSWARM_TOKEN;
  const server = serve(peer, token, 0);
  let actor: Store | undefined;
  process.env.BITSWARM_TOKEN = token;
  try {
    const statePath = join(f.dir, "actor");
    const joined = new Store(statePath, f.m);
    try {
      await sync(joined, server.url.origin, token);
    } finally {
      joined.close();
    }
    peer.who = f.owner;
    control(peer, { type: "cancel", block: "goal" });
    actor = new Store(statePath);
    const config = {
      pollMs: 50,
      deadlineMs: 300,
      goalBlocks: ["goal"],
      stopWhenComplete: true,
    };
    await expect(
      runAutomation(actor, { ...config, peers: [] }),
    ).rejects.toThrow("deadline");
    expect(actor.state()[0].status).toBe("ready");
    await expect(runAutomation(actor, config)).rejects.toThrow(
      "goal block cancelled",
    );
    expect(actor.state()[0].status).toBe("cancelled");
  } finally {
    if (old === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = old;
    server.stop(true);
    actor?.close();
    peer.close();
    f.cleanup();
  }
});

test("offline automation waits for missing task inputs without contacting saved peers", async () => {
  const bytes = Buffer.from("assigned source");
  const f = fixture([hash(bytes)]);
  const actor = new Store(join(f.dir, "actor"), f.m);
  const old = process.env.BITSWARM_TOKEN;
  const token = crypto.randomUUID();
  const seed = serve(f.store, token, 0);
  try {
    process.env.BITSWARM_TOKEN = token;
    f.store.addBlob(bytes);
    actor.rememberPeer(seed.url.origin);
    actor.configure({ download: "tasks", upload: "results" });
    await expect(
      runAutomation(actor, {
        peers: [],
        worker: {
          capabilities: [],
          command: [
            "bun",
            "-e",
            'console.log(JSON.stringify({summary:"Complete",artifact:{}}))',
          ],
        },
        pollMs: 50,
        deadlineMs: 300,
      }),
    ).rejects.toThrow("deadline");
    expect(actor.subscriptions()).toEqual(["goal"]);
    expect(actor.hasBlob(hash(bytes))).toBe(false);
    expect(actor.events().some((e) => e.payload.kind === "claim")).toBe(false);
  } finally {
    if (old === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = old;
    seed.stop(true);
    actor.close();
    f.cleanup();
  }
});

test("a stalled first peer leaves time to receive control from the next peer", async () => {
  const f = fixture();
  const peer = new Store(join(f.dir, "seed"), f.m);
  const token = crypto.randomUUID();
  const old = process.env.BITSWARM_TOKEN;
  process.env.BITSWARM_TOKEN = token;
  const seed = serve(peer, token, 0);
  let release!: (value: Response) => void;
  const holding = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const stalled = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => holding,
  });
  try {
    peer.who = f.owner;
    control(peer, { type: "cancel", block: "goal" });
    await expect(
      runAutomation(f.store, {
        peers: [stalled.url.origin, seed.url.origin],
        pollMs: 50,
        deadlineMs: 900,
        goalBlocks: ["goal"],
        stopWhenComplete: true,
      }),
    ).rejects.toThrow("goal block cancelled");
    expect(f.store.state()[0].status).toBe("cancelled");
  } finally {
    release(new Response(null, { status: 503 }));
    stalled.stop(true);
    seed.stop(true);
    if (old === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = old;
    peer.close();
    f.cleanup();
  }
});

test("work received in a partially failed final sync goes back through the scheduler", async () => {
  const f = fixture();
  const peer = new Store(join(f.dir, "seed"), f.m);
  const token = crypto.randomUUID();
  const old = process.env.BITSWARM_TOKEN;
  process.env.BITSWARM_TOKEN = token;
  let inventoryRounds = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (
        url.pathname === "/v1/inventory" &&
        url.searchParams.get("type") === "events" &&
        ++inventoryRounds === 2
      )
        control(peer, { type: "resume", block: "goal" });
      if (inventoryRounds === 2 && url.pathname === "/v1/wants")
        return new Response(null, { status: 503 });
      return handle(peer, token, req);
    },
  });
  try {
    f.store.who = peer.who = f.owner;
    control(f.store, { type: "cancel", block: "goal" });
    await expect(
      runAutomation(f.store, {
        peers: [server.url.origin],
        pollMs: 50,
        deadlineMs: 400,
        stopWhenComplete: true,
      }),
    ).rejects.toThrow("deadline");
    expect(f.store.state()[0].status).toBe("ready");
  } finally {
    server.stop(true);
    if (old === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = old;
    peer.close();
    f.cleanup();
  }
});
