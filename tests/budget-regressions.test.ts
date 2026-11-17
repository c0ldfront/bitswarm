import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  identity,
  digest,
  hash,
  makeEvent,
  type Manifest,
} from "../src/core.ts";
import { governance, control, checkpoint } from "../src/control.ts";
import { expenditure } from "../src/budget.ts";
import { Store } from "../src/store.ts";
import { claim, submit } from "../src/worker.ts";
function setup() {
  const planner = identity(),
    worker = identity();
  const m: Manifest = {
    version: 4,
    name: "Ledger",
    description: "Budget and recovery",
    validators: [planner.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "task",
        title: "Task",
        instructions: "Compute",
        inputs: [],
        requires: [],
        capabilities: [],
        contract: {
          timeoutMs: 10000,
          maxAttempts: 4,
          maxTokens: 60,
          maxCostMicros: 40,
          verifier: "checks",
          verifierHash: hash("recipe"),
        },
      },
    ],
  };
  return { planner, worker, m };
}
test("terminal events missing usage keep their reservation until a matching metered report arrives", () => {
  const { worker, m } = setup();
  const c = makeEvent(m, worker, {
    kind: "claim",
    block: "task",
    epoch: digest(m),
    dependencies: [],
    expires: Date.now() + 10000,
  });
  const fail = makeEvent(m, worker, {
    kind: "failure",
    claim: c.id,
    reason: "Unknown usage",
    retryable: true,
  });
  const unmetered = makeEvent(m, worker, {
    kind: "result",
    claim: c.id,
    block: "task",
    artifact: hash("{}"),
    summary: "Unmetered",
  });
  const wrong = makeEvent(m, worker, {
    kind: "result",
    claim: c.id,
    block: "other",
    artifact: hash("{}"),
    summary: "Unrelated",
    usage: { tokens: 0, costMicros: 0 },
  });
  for (const event of [fail, unmetered, wrong])
    expect(expenditure(m, [event, c]).get(worker.publicKey)).toEqual({
      tokens: 60,
      costMicros: 40,
    });
  const settled = makeEvent(m, worker, {
    kind: "result",
    claim: c.id,
    block: "task",
    artifact: hash("{}"),
    summary: "Accounted",
    usage: { tokens: 7, costMicros: 2 },
  });
  expect(
    expenditure(m, [fail, unmetered, settled, c]).get(worker.publicKey),
  ).toEqual({ tokens: 7, costMicros: 2 });
});
test("a rejected authority action preserves the last valid manifest and allocations", () => {
  const { m, worker, planner } = setup();
  m.policy = { admission: "invite", maxTokens: 30 };
  m.restricted = true;
  const parent = digest(m);
  const grant = makeEvent(m, planner, {
    kind: "control",
    parent,
    action: {
      type: "member",
      key: worker.publicKey,
      enabled: true,
      role: "worker",
      budget: { maxTokens: 60, maxCostMicros: 40, maxConcurrent: 1 },
    },
  });
  const state = governance(m, [grant]);
  expect(state.conflict).toBe(true);
  expect(state.head).toBe(parent);
  expect(state.members!.has(worker.publicKey)).toBe(false);
  const change = makeEvent(m, planner, {
    kind: "control",
    parent,
    action: { type: "policy", policy: { admission: "open" } },
  });
  const updated = governance(m, [change]);
  expect(updated.conflict).toBe(true);
  expect(updated.manifest.policy?.admission).toBe("invite");
});
test("checkpoint freezes a qualifying verification and preserves an approved result", () => {
  const { m, worker, planner } = setup(),
    dir = mkdtempSync(join(tmpdir(), "bitswarm-cp-proof-"));
  const s = new Store(dir, m);
  try {
    s.who = worker;
    const c = claim(s, "task"),
      r = submit(s, c.id, Buffer.from("{}"), "Computed", {
        tokens: 0,
        costMicros: 0,
      });
    s.who = planner;
    const verification = (recipe: string) =>
      makeEvent(
        m,
        planner,
        {
          kind: "verification",
          result: r.id,
          verifier: "checks",
          passed: true,
          report: s.addBlob(
            Buffer.from(
              JSON.stringify({
                result: r.id,
                verifier: "checks",
                recipe,
                checks: { passed: true, checks: [{ passed: true }] },
              }),
            ),
          ),
        },
        r.time,
      );
    let good = verification(hash("recipe"));
    // Stores sort by event ID; arrange for the nonqualifying attestation to be considered first.
    let bad = verification(hash("other"));
    while (bad.id >= good.id) {
      bad = verification(hash("other"));
      good = verification(hash("recipe"));
    }
    s.addEvent(good);
    s.addEvent(bad);
    s.addEvent(
      makeEvent(
        m,
        planner,
        {
          kind: "review",
          result: r.id,
          reason: "Reviewed",
          verdict: "approve",
        },
        r.time,
      ),
    );
    expect(s.state()[0].status).toBe("accepted");
    expect(() =>
      control(s, { type: "checkpoint", results: [r.id], evidence: [bad.id] }),
    ).toThrow("preserve acceptance");
    expect(s.governance().checkpoints!.size).toBe(0);
    checkpoint(s);
    expect(s.governance().checkpoints!.get("task")!.evidence.has(good.id)).toBe(
      true,
    );
    expect(s.state()[0].accepted?.id).toBe(r.id);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
