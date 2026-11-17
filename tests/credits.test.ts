import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { identity, makeEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { claim, submit } from "../src/worker.ts";
import { checkpoint } from "../src/control.ts";
import { creditState, mineCredits, transferCredits } from "../src/credits.ts";
test("contribution credits require checkpointed work, confirm on a work chain and cannot double spend", () => {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-credits-test-")),
    owner = identity(),
    worker = identity(),
    recipient = identity();
  const m: Manifest = {
    version: 3,
    name: "Credits",
    description: "Non-monetary ledger",
    validators: [owner.publicKey],
    quorum: 1,
    credits: { difficulty: 8, reward: 10, confirmations: 1 },
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
  const s = new Store(path, m);
  try {
    s.who = worker;
    const lease = claim(s, "x");
    const result = submit(s, lease.id, Buffer.from("{}"), "Contribution");
    expect(() => mineCredits(s, result.id)).toThrow("eligible");
    s.who = owner;
    s.addEvent(
      makeEvent(m, owner, {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Checked",
      }),
    );
    checkpoint(s);
    mineCredits(s, result.id);
    expect(creditState(s).balances[worker.publicKey]).toBe(10);
    s.who = worker;
    expect(() => transferCredits(s, recipient.publicKey, 3)).toThrow(
      "confirmed",
    );
    mineCredits(s);
    const transfer = transferCredits(s, recipient.publicKey, 3, 1);
    mineCredits(s, undefined, [transfer.id]);
    expect(creditState(s).balances[recipient.publicKey]).toBe(3);
    expect(() => mineCredits(s, undefined, [transfer.id])).toThrow("eligible");
    expect(creditState(s).balances[recipient.publicKey]).toBe(3);
  } finally {
    s.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test("a higher-work fork deterministically replaces a shorter credit history", () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-credit-fork-")),
    owner = identity(),
    worker = identity();
  const m: Manifest = {
    version: 3,
    name: "Fork",
    description: "Probabilistic confirmation semantics",
    validators: [owner.publicKey],
    quorum: 1,
    credits: { difficulty: 8, reward: 10, confirmations: 1 },
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
  const a = new Store(join(dir, "a"), m),
    b = new Store(join(dir, "b"), m);
  try {
    a.who = worker;
    const lease = claim(a, "x");
    const result = submit(a, lease.id, Buffer.from("{}"), "Contribution");
    a.who = owner;
    a.addEvent(
      makeEvent(m, owner, {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Checked",
      }),
    );
    checkpoint(a);
    for (const e of a.events()) b.addEvent(e);
    for (const id of a.inventory().blobs) b.addBlob(a.blob(id)!, id);
    mineCredits(a, result.id);
    mineCredits(a);
    b.who = worker;
    for (let i = 0; i < 3; i++) mineCredits(b, i === 0 ? result.id : undefined);
    for (const e of b.events()) a.addEvent(e);
    expect(creditState(a).tip.head).toBe(creditState(b).tip.head);
    expect(creditState(a).balances[worker.publicKey]).toBe(10);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
