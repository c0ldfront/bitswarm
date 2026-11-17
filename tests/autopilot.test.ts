import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { runAutomation } from "../src/autopilot.ts";
import { serve, sync } from "../src/network.ts";
test("autonomous actors plan, admit, execute, independently verify and checkpoint without operator calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-auto-test-")),
    key = identity();
  const contract = {
    timeoutMs: 5000,
    maxAttempts: 2,
    maxTokens: 0,
    maxCostMicros: 0,
    verifier: "fixture",
  };
  const m: Manifest = {
    version: 3,
    name: "Autonomous",
    description: "Full unattended lifecycle",
    validators: [key.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "plan",
        title: "Plan",
        instructions: "Discover a child",
        requires: [],
        inputs: [],
        capabilities: ["plan"],
        contract,
      },
    ],
  };
  const stores = ["owner", "planner", "worker"].map(
    (n) => new Store(join(dir, n), m),
  );
  const [owner, planner, worker] = stores;
  owner.who = key;
  const token = crypto.randomUUID();
  const old = process.env.BITSWARM_TOKEN;
  process.env.BITSWARM_TOKEN = token;
  const server = serve(owner, token, 0);
  const stop = new AbortController();
  const code =
    'const i=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify({summary:"done",artifact:i.block.id==="plan"?{plan:true}:{value:42},proposals:i.block.id==="plan"?[{reason:"Discovered work",block:{id:"child",title:"Child",instructions:"Compute",requires:["plan"],inputs:[],capabilities:["code"],contract:' +
    JSON.stringify(contract) +
    "}}]:[]}))";
  const verifier = [
    "bun",
    "-e",
    'const i=JSON.parse(await Bun.stdin.text());const passed=i.block.id==="plan"?i.artifact.plan===true:i.artifact.value===42;console.log(JSON.stringify({passed,checks:[{name:"independent fixture check",passed}]}))',
  ];
  try {
    for (const s of [planner, worker])
      await sync(s, server.url.toString(), token);
    const jobs = [
      runAutomation(
        planner,
        {
          peers: [server.url.toString()],
          worker: { command: ["bun", "-e", code], capabilities: ["plan"] },
          pollMs: 50,
          deadlineMs: 10000,
        },
        stop.signal,
      ).catch(() => {}),
      runAutomation(
        worker,
        {
          peers: [server.url.toString()],
          worker: { command: ["bun", "-e", code], capabilities: ["code"] },
          pollMs: 50,
          deadlineMs: 10000,
        },
        stop.signal,
      ).catch(() => {}),
    ];
    try {
      const outcome = await runAutomation(
        owner,
        {
          planner: {
            maxBlocks: 3,
            capabilities: ["code"],
            verifiers: ["fixture"],
            checkpoint: true,
          },
          reviewer: {
            verifiers: { fixture: verifier },
            autoApprove: true,
            isolation: "process",
          },
          pollMs: 50,
          deadlineMs: 10000,
          stopWhenComplete: true,
          goalBlocks: ["child"],
        },
        stop.signal,
      );
      expect(outcome.complete).toBe(true);
      expect(owner.state().every((s) => s.status === "accepted")).toBe(true);
      expect(owner.governance().checkpoints?.size).toBe(2);
    } finally {
      stop.abort();
      await Promise.all(jobs);
    }
  } finally {
    stop.abort();
    server.stop(true);
    stores.forEach((s) => s.close());
    if (old === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = old;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
