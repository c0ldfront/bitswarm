import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, makeEvent, type Manifest, digest } from "../src/core.ts";
import { backup, compact, restoreBackup } from "../src/operations.ts";
import { Store } from "../src/store.ts";
import { claim, submit } from "../src/worker.ts";
import { control } from "../src/control.ts";

function setup(policy: Manifest["policy"] = {}) {
  const parent = mkdtempSync(join(tmpdir(), "bitswarm-ops-regression-"));
  const owner = identity(),
    worker = identity();
  const manifest: Manifest = {
    version: 4,
    name: "Recovery",
    description: "Recovery regression",
    planner: owner.publicKey,
    validators: [owner.publicKey],
    quorum: 1,
    policy,
    blocks: [
      {
        id: "root",
        title: "Root",
        instructions: "Compute",
        inputs: [],
        requires: [],
        capabilities: [],
      },
    ],
  };
  const store = new Store(join(parent, "source"), manifest);
  store.who = owner;
  return {
    store,
    owner,
    worker,
    manifest,
    parent,
    close() {
      store.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test("compaction preserves an accepted result until its planner can checkpoint it", () => {
  const f = setup();
  try {
    f.store.who = f.worker;
    const first = claim(f.store, "root");
    const result = submit(f.store, first.id, Buffer.from("{}"), "Success");
    f.store.who = f.owner;
    f.store.addEvent(
      makeEvent(f.manifest, f.owner, {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Checked",
      }),
    );
    expect(f.store.state()[0].accepted?.id).toBe(result.id);
    compact(f.store);
    expect(f.store.state()[0].accepted?.id).toBe(result.id);
  } finally {
    f.close();
  }
});

test("restored nodes retain pinned objects, peers, upload accounting and automation history", () => {
  const f = setup();
  try {
    const root = f.store.addBlob(Buffer.from("irreplaceable"));
    f.store.db.query("INSERT INTO pins VALUES (?)").run(root);
    const peer = "http://127.0.0.1:7331";
    f.store.rememberPeer(peer);
    f.store.db
      .query("INSERT INTO blob_owners VALUES (?,?,?)")
      .run(root, f.worker.publicKey, 13);
    f.store.db
      .query("INSERT INTO automation VALUES (?,?,?,?)")
      .run("decision", "admitted", "task metadata", 123);
    const archive = join(f.parent, "backup"),
      path = join(f.parent, "restored");
    backup(f.store, archive, "test archive password");
    restoreBackup(archive, path, "test archive password");
    const restored = new Store(path);
    try {
      restored.collect();
      expect(restored.hasBlob(root)).toBe(true);
      expect(restored.peers()).toEqual([peer]);
      expect(
        restored.db.query("SELECT bytes FROM blob_owners WHERE id=?").get(root),
      ).toEqual({ bytes: 13 });
      expect(
        restored.db
          .query("SELECT status FROM automation WHERE key='decision'")
          .get(),
      ).toEqual({ status: "admitted" });
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("restore replays historical data that exceeded genesis limits after a policy change", () => {
  const f = setup({ storageBytes: 1 });
  try {
    control(f.store, { type: "policy", policy: { storageBytes: 20000 } });
    const id = f.store.addBlob(
      Buffer.from("larger than genesis storage allowance"),
    );
    const archive = join(f.parent, "backup"),
      path = join(f.parent, "restored");
    backup(f.store, archive, "test archive password");
    restoreBackup(archive, path, "test archive password");
    const restored = new Store(path);
    try {
      expect(restored.hasBlob(id)).toBe(true);
      expect(restored.governance().head).toBe(f.store.governance().head);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("a conflicted backup can be restored and reconciled by its validator", () => {
  const f = setup();
  try {
    const parent = digest(f.manifest);
    const branches = [1, 2].map((n) =>
      makeEvent(f.manifest, f.owner, {
        kind: "control",
        parent,
        action: { type: "policy", policy: { maxConcurrent: n } },
      }),
    );
    for (const e of branches) f.store.addEvent(e);
    expect(f.store.governance().conflict).toBe(true);
    const archive = join(f.parent, "backup"),
      path = join(f.parent, "restored");
    backup(f.store, archive, "test archive password");
    restoreBackup(archive, path, "test archive password");
    const restored = new Store(path);
    try {
      expect(restored.governance().conflict).toBe(true);
      restored.addEvent(
        makeEvent(f.manifest, f.owner, {
          kind: "reconcile",
          parent,
          selected: branches[0].id,
        }),
      );
      expect(restored.governance().conflict).toBe(false);
      expect(restored.governance().head).toBe(branches[0].id);
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("an interrupted accounting control rolls back archive chunks and pins", () => {
  const f = setup();
  try {
    f.store.who = f.worker;
    const pending = claim(f.store, "root");
    f.store.addEvent(
      makeEvent(f.manifest, f.worker, {
        kind: "failure",
        claim: pending.id,
        reason: "Failed",
        retryable: true,
      }),
    );
    f.store.who = f.owner;
    control(f.store, { type: "cancel", block: "root" });
    const before = f.store.inventory();
    f.store.db.exec(
      "CREATE TEMP TRIGGER interrupt_compaction BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'interrupted control'); END",
    );
    expect(() => compact(f.store)).toThrow("interrupted control");
    expect(f.store.inventory()).toEqual(before);
    expect(f.store.db.query("SELECT id FROM pins").all()).toEqual([]);
  } finally {
    f.close();
  }
});
