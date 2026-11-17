import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, makeEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { control, checkpoint } from "../src/control.ts";
import { claim, submit } from "../src/worker.ts";
import { backup, restoreBackup, compact } from "../src/operations.ts";
test("encrypted backup restores keys, state, source objects and rejects tampering atomically", () => {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-backup-test-"));
  const key = identity();
  const manifest: Manifest = {
    version: 2,
    name: "Backup",
    description: "Restoration rehearsal",
    validators: [key.publicKey],
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
  const source = join(path, "source");
  mkdirSync(source);
  writeFileSync(join(source, "identity.json"), JSON.stringify(key));
  const store = new Store(source, manifest);
  let restored: Store | undefined;
  try {
    const blob = store.addBlob(Buffer.from("backup content"));
    store.configure({
      download: "tasks",
      upload: "results",
      downloadBytes: 50,
    });
    store.subscribe("x");
    store.charge("download", 42);
    const file = join(path, "backup.json");
    backup(store, file, "a-long-backup-password");
    expect(readFileSync(file, "utf8")).not.toContain("PRIVATE KEY");
    const target = join(path, "restored");
    restoreBackup(file, target, "a-long-backup-password");
    restored = new Store(target);
    expect(restored.who.publicKey).toBe(key.publicKey);
    expect(restored.hasBlob(blob)).toBe(true);
    expect(restored.participation()).toEqual(store.participation());
    expect(restored.subscriptions()).toEqual(["x"]);
    expect(() => restored!.charge("download", 9)).toThrow("limit");
    expect(() =>
      restoreBackup(file, join(path, "wrong"), "a-different-password"),
    ).toThrow();
    expect(existsSync(join(path, "wrong"))).toBe(false);
  } finally {
    restored?.close();
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test("compaction archives failed attempts without resetting costs, authority or acceptance", () => {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-compact-test-")),
    owner = identity(),
    worker = identity();
  const m: Manifest = {
    version: 3,
    name: "Compaction",
    description: "Accounting conservation",
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
        contract: {
          timeoutMs: 10000,
          maxAttempts: 4,
          maxTokens: 20,
          maxCostMicros: 0,
        },
      },
    ],
  };
  const store = new Store(path, m);
  try {
    store.who = worker;
    const failed = claim(store, "x");
    store.addEvent(
      makeEvent(m, worker, {
        kind: "failure",
        claim: failed.id,
        reason: "A failed attempt",
        retryable: true,
        usage: { tokens: 10, costMicros: 0 },
      }),
    );
    const good = claim(store, "x");
    const result = submit(store, good.id, Buffer.from("{}"), "Verified", {
      tokens: 5,
      costMicros: 0,
    });
    store.who = owner;
    store.addEvent(
      makeEvent(m, owner, {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Checked",
      }),
    );
    checkpoint(store);
    const output = compact(store);
    expect(output.removed).toBe(2);
    expect(store.state()[0].status).toBe("accepted");
    store.who = worker;
    expect(store.usage().tokens).toBe(15);
    expect(store.event(failed.id)).toBeUndefined();
    store.addEvent(failed);
    expect(store.event(failed.id)).toBeUndefined();
    const encrypted = join(path, "archived.backup");
    backup(store, encrypted, "another-backup-password");
    const restoredDir = join(path, "restore");
    restoreBackup(encrypted, restoredDir, "another-backup-password");
    const restored = new Store(restoredDir);
    restored.who = worker;
    expect(restored.usage().tokens).toBe(15);
    expect(restored.state()[0].status).toBe("accepted");
    restored.close();
  } finally {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test("future schema versions are rejected instead of being downgraded", () => {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-schema-test-")),
    key = identity();
  const m: Manifest = {
    version: 2,
    name: "Schema",
    description: "Upgrade boundary",
    validators: [key.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "x",
        title: "X",
        instructions: "Do work",
        requires: [],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  const store = new Store(path, m);
  store.db.exec("PRAGMA user_version=999");
  store.close();
  try {
    expect(() => new Store(path)).toThrow("newer");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
