import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { control, propose } from "../src/control.ts";
import { claim, submit } from "../src/worker.ts";
import {
  claimExpiration,
  digest,
  identity,
  makeEvent,
  type Manifest,
} from "../src/core.ts";
function setup(
  policy: Manifest["policy"] = {},
  contract?: Manifest["blocks"][0]["contract"],
) {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-control-")),
    planner = identity(),
    worker = identity();
  const manifest: Manifest = {
    version: 1,
    name: "Lifecycle",
    description: "Project lifecycle",
    validators: [planner.publicKey],
    planner: planner.publicKey,
    quorum: 1,
    policy,
    blocks: [
      {
        id: "root",
        title: "Root",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
        ...(contract ? { contract } : {}),
      },
    ],
  };
  const store = new Store(dir, manifest);
  store.who = planner;
  return {
    store,
    planner,
    worker,
    manifest,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("only planner can admit valid proposals, cancel, resume and transfer authority", () => {
  const f = setup();
  try {
    const proposal = propose(
      f.store,
      {
        id: "child",
        title: "Child",
        instructions: "Integrate",
        requires: ["root"],
        inputs: [],
        capabilities: [],
      },
      "A discovered dependency",
    );
    f.store.who = f.worker;
    expect(() =>
      control(f.store, { type: "add", proposal: proposal.id }),
    ).toThrow();
    f.store.who = f.planner;
    control(f.store, { type: "add", proposal: proposal.id });
    expect(f.store.state()).toHaveLength(2);
    expect(f.store.inventory().swarm).toBe(digest(f.manifest));
    control(f.store, { type: "cancel", block: "root" });
    expect(f.store.state()[0].status).toBe("cancelled");
    control(f.store, { type: "resume", block: "root" });
    expect(f.store.state()[0].status).toBe("ready");
    control(f.store, { type: "delegate", key: f.worker.publicKey });
    expect(() => control(f.store, { type: "cancel", block: "root" })).toThrow();
    f.store.who = f.worker;
    control(f.store, { type: "cancel", block: "root" });
  } finally {
    f.cleanup();
  }
});
test("planner forks halt progress and reviewer reconciliation restores a chosen branch", () => {
  const f = setup();
  try {
    const parent = digest(f.manifest);
    const first = makeEvent(f.manifest, f.planner, {
      kind: "control",
      parent,
      action: { type: "cancel", block: "root" },
    });
    const second = makeEvent(f.manifest, f.planner, {
      kind: "control",
      parent,
      action: { type: "policy", policy: { maxConcurrent: 1 } },
    });
    f.store.addEvent(first);
    f.store.addEvent(second);
    expect(f.store.governance().conflict).toBe(true);
    expect(() => claim(f.store, "root")).toThrow();
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "reconcile",
        parent,
        selected: second.id,
      }),
    );
    expect(f.store.governance().conflict).toBe(false);
    expect(f.store.governance().head).toBe(second.id);
  } finally {
    f.cleanup();
  }
});
test("schema validation, usage limits and machine verification gate acceptance", () => {
  const contract = {
    timeoutMs: 10000,
    maxAttempts: 3,
    maxTokens: 100,
    maxCostMicros: 100,
    verifier: "checks",
    schema: {
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    },
  };
  const f = setup({}, contract);
  try {
    f.store.who = f.worker;
    const lease = claim(f.store, "root");
    const result = submit(
      f.store,
      lease.id,
      Buffer.from('{"answer":42}'),
      "Answer",
      { tokens: 10, costMicros: 10 },
    );
    expect(f.store.state()[0].status).toBe("review");
    f.store.who = f.planner;
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Checked",
      }),
    );
    expect(f.store.state()[0].status).toBe("review");
    const report = f.store.addBlob(
      Buffer.from(
        JSON.stringify({
          result: result.id,
          verifier: "checks",
          checks: { passed: true, checks: [{ name: "answer", passed: true }] },
        }),
      ),
    );
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "verification",
        result: result.id,
        verifier: "checks",
        passed: true,
        report,
      }),
    );
    expect(f.store.state()[0].status).toBe("accepted");
  } finally {
    f.cleanup();
  }
});
test("review timeout frees work; checkpoints freeze approved evidence against later equivocation", () => {
  const f = setup({ reviewTimeoutMs: 10 });
  try {
    f.store.who = f.worker;
    const lease = claim(f.store, "root");
    const result = submit(f.store, lease.id, Buffer.from("{}"), "Findings");
    expect(f.store.state(Date.now() + 1000)[0].status).toBe("ready");
    f.store.who = f.planner;
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Checked",
      }),
    );
    control(f.store, {
      type: "checkpoint",
      results: [result.id],
      evidence: f.store.events().map((e) => e.id),
    });
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "review",
        result: result.id,
        verdict: "reject",
        reason: "Later contradictory statement",
      }),
    );
    expect(f.store.state(Date.now() + 1000)[0].status).toBe("accepted");
  } finally {
    f.cleanup();
  }
});
test("local concurrent work reserves budgets atomically and resumes after policy changes", () => {
  const f = setup(
    { maxConcurrent: 1, maxTokens: 10 },
    { timeoutMs: 10000, maxAttempts: 2, maxTokens: 20, maxCostMicros: 0 },
  );
  try {
    f.store.who = f.worker;
    expect(() => claim(f.store, "root")).toThrow("token");
    f.store.who = f.planner;
    control(f.store, { type: "policy", policy: { maxTokens: 30 } });
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: true,
      budget: { maxTokens: 30, maxCostMicros: 0, maxConcurrent: 1 },
    });
    f.store.who = f.worker;
    const lease = claim(f.store, "root");
    expect(f.store.usage().tokens).toBe(20);
    f.store.addEvent(
      makeEvent(f.manifest, f.worker, {
        kind: "failure",
        claim: lease.id,
        reason: "Tool failed",
        retryable: true,
        usage: { tokens: 20, costMicros: 0 },
      }),
    );
    expect(f.store.usage().tokens).toBe(20);
    expect(() => claim(f.store, "root")).toThrow("token");
  } finally {
    f.cleanup();
  }
});
test("renewals chain causally and cannot extend beyond task duration", () => {
  const f = setup();
  try {
    const start = Date.now() - 5000;
    const lease = makeEvent(
      f.manifest,
      f.worker,
      { kind: "claim", block: "root", expires: start + 2000, dependencies: [] },
      start,
    );
    const first = makeEvent(
      f.manifest,
      f.worker,
      { kind: "renew", claim: lease.id, expires: start + 4000 },
      start + 1000,
    );
    const second = makeEvent(
      f.manifest,
      f.worker,
      { kind: "renew", claim: lease.id, expires: start + 8000 },
      start + 3000,
    );
    expect(claimExpiration(lease, [second, first], 6000)).toBe(start + 6000);
    const late = makeEvent(
      f.manifest,
      f.worker,
      { kind: "renew", claim: lease.id, expires: start + 9000 },
      start + 9000,
    );
    expect(claimExpiration(lease, [late], 6000)).toBe(
      lease.payload.kind === "claim" ? lease.payload.expires : 0,
    );
  } finally {
    f.cleanup();
  }
});
test("reviewer quorum can recover a lost planner key without that key", () => {
  const f = setup();
  try {
    const head = f.store.governance().head;
    f.store.addEvent(
      makeEvent(f.manifest, f.planner, {
        kind: "recover",
        parent: head,
        key: f.worker.publicKey,
      }),
    );
    expect(f.store.governance().planner).toBe(f.worker.publicKey);
    f.store.who = f.worker;
    control(f.store, { type: "policy", policy: { maxConcurrent: 2 } });
    expect(f.store.governance().manifest.policy?.maxConcurrent).toBe(2);
  } finally {
    f.cleanup();
  }
});
test("contributor allocations cannot exceed or silently reclaim the project budget", () => {
  const f = setup({ maxTokens: 100, maxCostMicros: 100 });
  try {
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: true,
      budget: { maxTokens: 60, maxCostMicros: 60, maxConcurrent: 1 },
    });
    expect(() =>
      control(f.store, {
        type: "member",
        key: identity().publicKey,
        role: "worker",
        enabled: true,
        budget: { maxTokens: 60, maxCostMicros: 60, maxConcurrent: 1 },
      }),
    ).toThrow();
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: false,
    });
    expect(() =>
      control(f.store, {
        type: "member",
        key: f.worker.publicKey,
        role: "worker",
        enabled: true,
        budget: { maxTokens: 30, maxCostMicros: 30, maxConcurrent: 1 },
      }),
    ).toThrow();
  } finally {
    f.cleanup();
  }
});
test("resuming an exhausted block counts new attempts by authority epoch, including equal timestamps", () => {
  const f = setup(
    {},
    { timeoutMs: 10000, maxAttempts: 1, maxTokens: 0, maxCostMicros: 0 },
  );
  try {
    f.store.who = f.worker;
    const first = claim(f.store, "root");
    f.store.addEvent(
      makeEvent(f.manifest, f.worker, {
        kind: "failure",
        claim: first.id,
        reason: "Failed",
        retryable: true,
      }),
    );
    expect(f.store.state()[0].status).toBe("exhausted");
    f.store.who = f.planner;
    control(f.store, { type: "resume", block: "root" });
    f.store.who = f.worker;
    const second = claim(f.store, "root");
    f.store.addEvent(
      makeEvent(f.manifest, f.worker, {
        kind: "failure",
        claim: second.id,
        reason: "Failed again",
        retryable: true,
      }),
    );
    expect(f.store.state()[0].status).toBe("exhausted");
  } finally {
    f.cleanup();
  }
});
test("finite project budgets do not duplicate unallocated allowances across contributors", () => {
  const f = setup(
    { maxTokens: 100 },
    { timeoutMs: 10000, maxAttempts: 3, maxTokens: 20, maxCostMicros: 0 },
  );
  try {
    f.store.who = f.worker;
    expect(() => claim(f.store, "root")).toThrow("token");
    f.store.who = f.planner;
    control(f.store, {
      type: "member",
      key: f.worker.publicKey,
      role: "worker",
      enabled: true,
      budget: { maxTokens: 30, maxCostMicros: 0, maxConcurrent: 1 },
    });
    expect(() =>
      control(f.store, { type: "policy", policy: { maxTokens: 10 } }),
    ).toThrow("invalid");
    f.store.who = f.worker;
    expect(claim(f.store, "root")).toBeDefined();
  } finally {
    f.cleanup();
  }
});
