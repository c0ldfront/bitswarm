import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { Store } from "./store.ts";
import { assert, hash, canonical, type Event } from "./core.ts";
import { control } from "./control.ts";
import { expenditure, budgetSummary } from "./budget.ts";
export function backup(store: Store, path: string, password: string) {
  assert(
    password.length >= 16,
    "Set BITSWARM_BACKUP_PASSPHRASE to at least 16 characters",
  );
  const files: Record<string, string> = {};
  for (const name of [
    "identity.json",
    "access.json",
    "mesh.key",
    "selection.json",
  ])
    if (existsSync(join(store.directory, name)))
      files[name] = readFileSync(join(store.directory, name)).toString(
        "base64",
      );
  const payload = gzipSync(
    Buffer.from(
      canonical({
        format: "bitswarm.backup.v1",
        schema: 4,
        manifest: store.manifest,
        events: store.events(),
        objects: Object.fromEntries(
          store
            .inventory()
            .blobs.map((id) => [
              id,
              Buffer.from(store.blob(id)!).toString("base64"),
            ]),
        ),
        participation: store.participation() ?? null,
        subscriptions: store.subscriptions(),
        downloadedBytes: store.usedBytes("download"),
        uploadedBytes: store.usedBytes("upload"),
        files,
      }),
    ),
  );
  const salt = randomBytes(16),
    nonce = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      scryptSync(password, salt, 32),
      nonce,
    );
  cipher.setAAD(Buffer.from("bitswarm.backup.v1"));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  writeFileSync(
    path,
    JSON.stringify({
      format: "bitswarm.backup.v1",
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    }),
    { flag: "wx", mode: 0o600 },
  );
  return {
    path,
    events: store.events().length,
    objects: store.inventory().blobs.length,
    encrypted: true,
  };
}
export function restoreBackup(
  path: string,
  directory: string,
  password: string,
) {
  assert(password.length >= 16, "Missing backup passphrase");
  const target = resolve(directory);
  assert(!existsSync(target), "Restore requires a new state directory");
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  assert(envelope.format === "bitswarm.backup.v1", "Unsupported backup format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    scryptSync(password, Buffer.from(envelope.salt, "base64"), 32),
    Buffer.from(envelope.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(envelope.format));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const archive = JSON.parse(
    gunzipSync(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]),
      { maxOutputLength: 512 * 1024 * 1024 },
    ).toString(),
  );
  assert(
    archive.format === envelope.format && archive.schema <= 4,
    "Unsupported backup schema",
  );
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), ".bitswarm-restore-"));
  let store: Store | undefined;
  try {
    store = new Store(stage, archive.manifest);
    for (const [id, body] of Object.entries(archive.objects))
      store.addBlob(Buffer.from(body as string, "base64"), id);
    for (const e of archive.events) store.addEvent(e);
    assert(
      !store.governance().conflict,
      "Backup contains an unresolved governance conflict",
    );
    for (const [name, body] of Object.entries(archive.files)) {
      assert(
        ["identity.json", "access.json", "mesh.key", "selection.json"].includes(
          name,
        ),
        "Unsafe backup file",
      );
      writeFileSync(join(stage, name), Buffer.from(body as string, "base64"), {
        mode: 0o600,
      });
    }
    if (archive.participation) store.configure(archive.participation);
    for (const id of archive.subscriptions ?? []) store.subscribe(id);
    for (const [direction, bytes] of [
      ["download", archive.downloadedBytes],
      ["upload", archive.uploadedBytes],
    ] as const)
      if (bytes !== undefined) {
        assert(
          Number.isSafeInteger(bytes) && bytes >= 0,
          "Invalid backup transfer counter",
        );
        store.transfer(direction, bytes);
      }
    store.close();
    store = undefined;
    renameSync(stage, target);
    return { directory: target, events: archive.events.length };
  } catch (e) {
    store?.close();
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}
export function compact(store: Store) {
  assert(
    store.manifest.version >= 3,
    "Compaction requires protocol 3; archive legacy projects with backup",
  );
  const before = store.events().length;
  let removed = 0;
  const g = store.governance();
  assert(
    store.who.publicKey === g.planner,
    "Only the planner can compact signed accounting history",
  );
  const states = store.state();
  const preserved = new Set([...g.checkpoints!.values()].map((c) => c.result));
  const resultClaims = new Set(
    store
      .events()
      .filter((e) => preserved.has(e.id) && e.payload.kind === "result")
      .map((e) => (e.payload as { claim: string }).claim),
  );
  const claims = store
    .events()
    .filter(
      (e) =>
        e.payload.kind === "claim" &&
        !resultClaims.has(e.id) &&
        states.some(
          (s) =>
            s.block.id === (e.payload as { block: string }).block &&
            ["accepted", "cancelled"].includes(s.status),
        ),
    );
  for (const claim of claims) {
    const resultIds = new Set(
      store
        .events()
        .filter(
          (e) => e.payload.kind === "result" && e.payload.claim === claim.id,
        )
        .map((e) => e.id),
    );
    const records = store
      .events()
      .filter(
        (e) =>
          e.id === claim.id ||
          ((e.payload.kind === "result" ||
            e.payload.kind === "failure" ||
            e.payload.kind === "renew") &&
            e.payload.claim === claim.id) ||
          ((e.payload.kind === "review" || e.payload.kind === "verification") &&
            resultIds.has(e.payload.result)),
      );
    if (records.length > 200) continue;
    const compressed = gzipSync(Buffer.from(canonical(records)));
    const chunks: string[] = [];
    for (let i = 0; i < compressed.length; i += 256 * 1024)
      chunks.push(store.addBlob(compressed.subarray(i, i + 256 * 1024)));
    const index = Buffer.from(
      canonical({
        type: "bitswarm.file.v1",
        name: "events.json.gz",
        size: compressed.length,
        sha256: hash(compressed),
        chunks,
      }),
    );
    const root = store.addBlob(index);
    store.db.query("INSERT OR IGNORE INTO pins VALUES (?)").run(root);
    const amounts = Object.fromEntries(expenditure(g.manifest, records));
    const p = claim.payload as { block: string; epoch?: string };
    control(store, {
      type: "accounting",
      archive: root,
      dropped: records.map((e) => e.id),
      usage: amounts,
      attempts: { [p.block + "#" + (p.epoch || "legacy")]: 1 },
    });
    store.db.transaction(() => {
      for (const e of records)
        store.db.query("DELETE FROM events WHERE id=?").run(e.id);
    })();
    removed += records.length;
  }
  return {
    before,
    after: store.events().length,
    removed,
    budget: budgetSummary(store.governance(), store.events()),
  };
}
