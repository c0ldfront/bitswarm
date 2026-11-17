import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, makeEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { checkpoint } from "../src/control.ts";
import { claim, submit } from "../src/worker.ts";
import { mineCredits, transferCredits } from "../src/credits.ts";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-credit-maturity-"));
  const owner = identity(),
    worker = identity(),
    recipient = identity();
  const manifest: Manifest = {
    version: 4,
    name: "Confirmed credits",
    description: "Check maturity on each branch",
    validators: [owner.publicKey],
    quorum: 1,
    credits: { difficulty: 8, reward: 10, confirmations: 2 },
    blocks: [
      {
        id: "item",
        title: "Item",
        instructions: "Review",
        inputs: [],
        requires: [],
        capabilities: [],
      },
    ],
  };
  const store = new Store(join(dir, "seed"), manifest);
  store.who = worker;
  const result = submit(
    store,
    claim(store, "item").id,
    Buffer.from("{}"),
    "Work",
  );
  store.who = owner;
  store.addEvent(
    makeEvent(manifest, owner, {
      kind: "review",
      result: result.id,
      verdict: "approve",
      reason: "Verified",
    }),
  );
  checkpoint(store);
  mineCredits(store, result.id);
  store.who = worker;
  return {
    dir,
    store,
    recipient,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a peer waits for its own branch to mature before including another peer's transfer", () => {
  const p = project();
  const replica = new Store(join(p.dir, "replica"), p.store.manifest);
  try {
    for (const e of p.store.events()) replica.addEvent(e);
    for (const id of p.store.inventory().blobs)
      replica.addBlob(p.store.blob(id)!, id);
    mineCredits(p.store);
    mineCredits(p.store);
    const transfer = transferCredits(p.store, p.recipient.publicKey, 4);
    replica.addEvent(transfer);
    expect(() => mineCredits(replica, undefined, [transfer.id])).toThrow(
      "eligible",
    );
    mineCredits(replica);
    expect(() => mineCredits(replica, undefined, [transfer.id])).toThrow(
      "eligible",
    );
    mineCredits(replica);
    expect(mineCredits(replica, undefined, [transfer.id]).payload.kind).toBe(
      "creditblock",
    );
  } finally {
    replica.close();
    p.close();
  }
});

test("a wallet excludes previously confirmed inputs spent above its confirmed head", () => {
  const p = project();
  try {
    mineCredits(p.store);
    mineCredits(p.store);
    const transfer = transferCredits(p.store, p.recipient.publicKey, 4);
    mineCredits(p.store, undefined, [transfer.id]);
    expect(() => transferCredits(p.store, p.recipient.publicKey, 1)).toThrow(
      "confirmed",
    );
    mineCredits(p.store);
    mineCredits(p.store);
    const change = transferCredits(p.store, p.recipient.publicKey, 6);
    expect(mineCredits(p.store, undefined, [change.id]).payload.kind).toBe(
      "creditblock",
    );
  } finally {
    p.close();
  }
});
