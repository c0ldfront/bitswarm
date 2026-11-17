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
  linkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { Store } from "./store.ts";
import {
  assert,
  hash,
  canonical,
  validateEvent,
  MAX_BLOB,
  type Event,
} from "./core.ts";
import { control } from "./control.ts";
import { expenditure, budgetSummary } from "./budget.ts";
// These tables contain local-only state that cannot be rebuilt by gossip.
const localTables = {
  pins: ["id"],
  peers: ["address", "failures", "nextRetry"],
  blob_owners: ["id", "author", "bytes"],
  quarantine: ["peer", "id", "reason", "attempts"],
  automation: ["key", "status", "detail", "time"],
  nonces: ["id", "expires"],
  transfer: ["key", "bytes"],
} as const;
const maxArchiveBytes = 512 * 1024 * 1024;

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
  // A second local process can work or compact while this read transaction is open.
  const snapshot = store.db.transaction(() => {
    const events = (
      store.db.query("SELECT body FROM events ORDER BY id").all() as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as Event);
    const objects = Object.fromEntries(
      (
        store.db.query("SELECT id,body FROM blobs ORDER BY id").all() as {
          id: string;
          body: Uint8Array;
        }[]
      ).map((row) => [row.id, Buffer.from(row.body).toString("base64")]),
    );
    const local = Object.fromEntries(
      Object.entries(localTables).map(([table, columns]) => [
        table,
        store.db.query(`SELECT ${columns.join(",")} FROM ${table}`).values(),
      ]),
    );
    return {
      format: "bitswarm.backup.v1",
      schema: 4,
      manifest: store.manifest,
      events,
      objects,
      participation: store.participation() ?? null,
      subscriptions: store.subscriptions(),
      downloadedBytes: store.usedBytes("download"),
      uploadedBytes: store.usedBytes("upload"),
      files,
      local,
    };
  })();
  const bytes = Buffer.from(canonical(snapshot));
  assert(
    bytes.length <= maxArchiveBytes,
    "Backup exceeds the supported restore size",
  );
  const payload = gzipSync(bytes);
  const salt = randomBytes(16),
    nonce = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      scryptSync(password, salt, 32),
      nonce,
    );
  cipher.setAAD(Buffer.from("bitswarm.backup.v1"));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const stage = mkdtempSync(join(dirname(resolve(path)), ".bitswarm-backup-"));
  try {
    const temporary = join(stage, "archive");
    writeFileSync(
      temporary,
      JSON.stringify({
        format: "bitswarm.backup.v1",
        salt: salt.toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      }),
      { flag: "wx", mode: 0o600 },
    );
    linkSync(temporary, path);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return {
    path,
    events: snapshot.events.length,
    objects: Object.keys(snapshot.objects).length,
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
      { maxOutputLength: maxArchiveBytes },
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
    // Restore admitted history using the immutable signature and content checks.
    // Live admission quotas may have changed since those records were accepted.
    const staged = store;
    staged.db.transaction(() => {
      const putBlob = staged.db.query("INSERT INTO blobs VALUES (?,?)");
      for (const [id, body] of Object.entries(archive.objects)) {
        assert(typeof body === "string", "Invalid archived object");
        const bytes = Buffer.from(body, "base64");
        assert(
          bytes.length <= MAX_BLOB && hash(bytes) === id,
          "Invalid archived object hash or size",
        );
        putBlob.run(id, bytes);
      }
      const putEvent = staged.db.query("INSERT INTO events VALUES (?,?)");
      for (const event of archive.events) {
        validateEvent(event, staged.manifest);
        putEvent.run(event.id, canonical(event));
      }
      if (archive.local)
        for (const [table, columns] of Object.entries(localTables)) {
          const rows = archive.local[table];
          assert(Array.isArray(rows), "Missing archived " + table + " table");
          const put = staged.db.query(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          );
          for (const row of rows) {
            assert(
              Array.isArray(row) && row.length === columns.length,
              "Invalid archived " + table + " row",
            );
            put.run(...row);
          }
        }
    })();
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
      if (!archive.local && bytes !== undefined) {
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
  return store.db
    .transaction(() => {
      const before = store.events().length;
      let removed = 0;
      const g = store.governance();
      assert(
        store.who.publicKey === g.planner,
        "Only the planner can compact signed accounting history",
      );
      const states = store.state();
      // Accepted outputs can be checkpointed later; a cancelled task may be resumed.
      // Keep causal references used by other attempts and every checkpoint in the chain.
      const preserved = new Set<string>();
      for (const e of store.events()) {
        if (e.payload.kind === "claim")
          for (const id of e.payload.dependencies) preserved.add(id);
        if (
          e.payload.kind === "control" &&
          e.payload.action.type === "checkpoint"
        )
          for (const id of [
            ...e.payload.action.results,
            ...e.payload.action.evidence,
          ])
            preserved.add(id);
      }
      const claims = store
        .events()
        .filter(
          (e) =>
            e.payload.kind === "claim" &&
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
              (e) =>
                e.payload.kind === "result" && e.payload.claim === claim.id,
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
              ((e.payload.kind === "review" ||
                e.payload.kind === "verification") &&
                resultIds.has(e.payload.result)),
          );
        if (records.some((e) => preserved.has(e.id)) || records.length > 200)
          continue;
        const p = claim.payload;
        if (p.kind !== "claim") continue;
        // Without a finalized winner, the remaining results can still affect a review,
        // a dispute, or a future resume. Only prune irrevocably failed attempts here.
        if (
          !g.checkpoints?.has(p.block) &&
          (resultIds.size ||
            !records.some(
              (e) => e.author === claim.author && e.payload.kind === "failure",
            ))
        )
          continue;
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
    })
    .immediate();
}
