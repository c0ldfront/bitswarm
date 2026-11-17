import { expenditure } from "./budget.ts";
import { governance } from "./control.ts";
import { Database, SQLiteError } from "bun:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  linkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  assert,
  canonical,
  digest,
  hash,
  identity,
  isHash,
  MAX_BLOB,
  MAX_EVENTS,
  project,
  validateEvent,
  validateManifest,
  type Event,
  type Identity,
  type Manifest,
} from "./core.ts";

export type Participation = {
  download: "metadata" | "tasks" | "mirror";
  upload: "results" | "cache";
  downloadBytes?: number;
  uploadBytes?: number;
  only?: string[];
};
export function stateIdentity(directory: string, persist = true): Identity {
  const path = join(directory, "identity.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const generated = identity();
  if (!persist) return generated;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, ".identity-" + randomUUID());
  try {
    writeFileSync(temporary, canonical(generated), { flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another initializer won. Its key was completely written before linking.
      return JSON.parse(readFileSync(path, "utf8"));
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
function availablePeers(db: Database): string[] {
  return (
    db
      .query(
        "SELECT address FROM peers WHERE nextRetry <= ? ORDER BY failures,address LIMIT 32",
      )
      .all(Date.now()) as { address: string }[]
  ).map((r) => r.address);
}
export class Store {
  db: Database;
  manifest!: Manifest;
  who: Identity;
  private cached?: {
    stamp: string;
    events: Event[];
    g: ReturnType<typeof governance>;
  };
  constructor(
    public directory: string,
    manifest?: Manifest,
    initialParticipation?: Participation,
    seed?: (store: Store) => void,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "manifest.json");
    const fresh = !existsSync(path);
    const dbPath = join(directory, "swarm.sqlite");
    const selectManifest = (saved?: Manifest) => {
      assert(
        !saved || !manifest || digest(manifest) === digest(saved),
        "State directory belongs to another swarm",
      );
      const selected = saved ?? manifest;
      assert(selected, "Initialize or join a swarm first");
      validateManifest(selected);
      return selected;
    };
    if (!fresh)
      this.manifest = selectManifest(JSON.parse(readFileSync(path, "utf8")));
    else
      assert(
        manifest || existsSync(dbPath),
        "Initialize or join a swarm first",
      );
    this.who = stateIdentity(directory);
    this.db = new Database(dbPath, { create: true });
    try {
      const busyTimeoutMs = 5000;
      const busyTimeoutPragma = "PRAGMA busy_timeout = " + busyTimeoutMs;
      this.db.exec(busyTimeoutPragma);
      const schema = (
        this.db.query("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      assert(schema <= 4, "Database schema is newer than this binary");
      // SQLite can decline to call the busy handler when simultaneous journal
      // upgrades would deadlock. Retry the whole pragma after releasing its locks.
      const walDeadline = performance.now() + busyTimeoutMs;
      this.db.exec("PRAGMA busy_timeout = 0");
      for (;;) {
        try {
          this.db.exec("PRAGMA journal_mode = WAL");
          break;
        } catch (error) {
          const remaining = walDeadline - performance.now();
          if (
            !(error instanceof SQLiteError) ||
            !error.code?.startsWith("SQLITE_BUSY") ||
            remaining <= 0
          )
            throw error;
          Bun.sleepSync(Math.min(20, remaining));
        }
      }
      this.db.exec(busyTimeoutPragma);
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS automation (key TEXT PRIMARY KEY,status TEXT,detail TEXT,time INTEGER); CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, body BLOB NOT NULL); CREATE TABLE IF NOT EXISTS pins (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS quarantine (peer TEXT, id TEXT, reason TEXT, attempts INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(peer,id)); CREATE TABLE IF NOT EXISTS peers (address TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, nextRetry INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS transfer (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS blob_owners (id TEXT PRIMARY KEY, author TEXT, bytes INTEGER);",
      );
      this.db.exec("PRAGMA user_version=4");
      const genesis = this.db.query(
        "SELECT value FROM settings WHERE key='genesis'",
      );
      if (!fresh) {
        const pinned = genesis.get() as { value: string } | null;
        assert(
          !pinned || pinned.value === canonical(this.manifest),
          "State directory belongs to another swarm",
        );
      }
      if (fresh || seed)
        this.db
          .transaction(() => {
            if (fresh) {
              const saved = genesis.get() as { value: string } | null;
              this.manifest = selectManifest(
                saved ? JSON.parse(saved.value) : undefined,
              );
              if (!saved) {
                if (initialParticipation) this.configure(initialParticipation);
                this.db
                  .query("INSERT INTO settings VALUES ('genesis',?)")
                  .run(canonical(this.manifest));
              }
            }
            seed?.(this);
          })
          .immediate();
      // Publish the filesystem copy only after the seed and its genesis commit.
      // Another opener can finish this step if the importing process stops.
      if (fresh)
        this.db
          .transaction(() => {
            if (existsSync(path)) {
              assert(
                digest(JSON.parse(readFileSync(path, "utf8"))) ===
                  digest(this.manifest),
                "State directory belongs to another swarm",
              );
              return;
            }
            const temporary = join(directory, ".manifest-" + randomUUID());
            try {
              writeFileSync(temporary, canonical(this.manifest), {
                mode: 0o600,
                flag: "wx",
              });
              renameSync(temporary, path);
            } finally {
              rmSync(temporary, { force: true });
            }
          })
          .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private view() {
    const row = this.db
      .query("SELECT COUNT(*) AS n,MAX(rowid) AS last FROM events")
      .get() as { n: number; last: number };
    const version = this.db.query("PRAGMA data_version").get() as Record<
      string,
      number
    >;
    const stamp = row.n + ":" + row.last + ":" + Object.values(version)[0];
    if (this.cached?.stamp === stamp) return this.cached;
    const raw = (
      this.db.query("SELECT body FROM events ORDER BY id").all() as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body) as Event);
    const g = governance(this.manifest, raw);
    return (this.cached = {
      stamp,
      events: raw.filter((e) => !g.compacted?.has(e.id)),
      g,
    });
  }
  events(): Event[] {
    return this.view().events;
  }
  event(id: string): Event | undefined {
    if (this.governance().compacted?.has(id)) return undefined;
    const row = this.db
      .query("SELECT body FROM events WHERE id = ?")
      .get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  addEvent(event: Event): void {
    validateEvent(event, this.manifest);
    if (this.governance().compacted?.has(event.id)) return;
    this.db.transaction(() => {
      if (this.event(event.id)) return;
      const count = this.db.query("SELECT COUNT(*) AS n FROM events").get() as {
        n: number;
      };
      assert(
        count.n < MAX_EVENTS ||
          (count.n < MAX_EVENTS + 100 &&
            event.payload.kind === "control" &&
            event.payload.action.type === "accounting" &&
            event.author === this.governance().planner),
        "Event storage limit reached",
      );
      const authored = this.events().filter(
        (e) => e.author === event.author,
      ).length;
      assert(
        authored < (this.governance().manifest.policy?.eventQuota ?? 2000),
        "Contributor event quota exceeded",
      );
      this.db
        .query("INSERT INTO events VALUES (?, ?)")
        .run(event.id, canonical(event));
    })();
  }
  blob(id: string): Uint8Array | undefined {
    return (
      this.db.query("SELECT body FROM blobs WHERE id = ?").get(id) as {
        body: Uint8Array;
      } | null
    )?.body;
  }
  hasBlob = (id: string): boolean =>
    !!this.db.query("SELECT 1 FROM blobs WHERE id = ?").get(id);
  addBlob(data: Uint8Array, expected = hash(data)): string {
    assert(
      isHash(expected) && hash(data) === expected && data.length <= MAX_BLOB,
      "Blob hash mismatch or blob exceeds 1 MiB",
    );
    this.db.transaction(() => {
      if (this.hasBlob(expected)) return;
      const usage = this.db
        .query(
          "SELECT COALESCE(SUM(LENGTH(body)),0) AS bytes, COUNT(*) AS n FROM blobs",
        )
        .get() as { bytes: number; n: number };
      assert(
        usage.bytes + data.length <=
          (this.governance().manifest.policy?.storageBytes ?? 128 * MAX_BLOB) &&
          usage.n < 10_000,
        "Blob storage limit reached",
      );
      this.db.query("INSERT INTO blobs VALUES (?, ?)").run(expected, data);
    })();
    return expected;
  }
  inventory(): { swarm: string; events: string[]; blobs: string[] } {
    return {
      swarm: digest(this.manifest),
      events: this.events().map((e) => e.id),
      blobs: (
        this.db.query("SELECT id FROM blobs ORDER BY id").all() as {
          id: string;
        }[]
      ).map((r) => r.id),
    };
  }
  participation(): Participation | undefined {
    const row = this.db
      .query("SELECT value FROM settings WHERE key='participation'")
      .get() as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  configure(profile: Participation) {
    assert(
      ["metadata", "tasks", "mirror"].includes(profile.download) &&
        ["results", "cache"].includes(profile.upload),
      "Invalid participation mode",
    );
    for (const limit of [profile.downloadBytes, profile.uploadBytes])
      assert(
        limit === undefined || (Number.isSafeInteger(limit) && limit >= 0),
        "Invalid payload byte limit",
      );
    assert(
      !profile.only ||
        (Array.isArray(profile.only) &&
          profile.only.length <= 1000 &&
          profile.only.every(
            (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id),
          )),
      "Invalid task selection",
    );
    this.db
      .query("INSERT OR REPLACE INTO settings VALUES ('participation',?)")
      .run(canonical(profile));
  }
  usedBytes(direction: "download" | "upload") {
    return (
      (
        this.db
          .query("SELECT bytes FROM transfer WHERE key=?")
          .get(direction) as { bytes: number } | null
      )?.bytes ?? 0
    );
  }
  charge(direction: "download" | "upload", bytes: number) {
    this.db
      .transaction(() => {
        const cap =
          this.participation()?.[
            direction === "download" ? "downloadBytes" : "uploadBytes"
          ];
        assert(
          cap === undefined || bytes <= cap - this.usedBytes(direction),
          direction + " payload limit exceeded",
        );
        this.transfer(direction, bytes);
      })
      .immediate();
  }
  expandRoots(roots: Iterable<string>) {
    const ids = new Set(roots);
    for (const id of [...ids]) {
      const raw = this.blob(id);
      if (!raw) continue;
      try {
        const idx = JSON.parse(Buffer.from(raw).toString());
        if (
          idx?.type === "bitswarm.file.v1" &&
          Array.isArray(idx.chunks) &&
          idx.chunks.length <= 8192 &&
          idx.chunks.every(isHash)
        )
          for (const chunk of idx.chunks) ids.add(chunk);
      } catch {}
    }
    return ids;
  }
  taskInputs(block: Manifest["blocks"][number]) {
    const roots = new Set(block.inputs);
    for (const e of this.events())
      if (
        e.author === this.who.publicKey &&
        e.payload.kind === "input-request" &&
        e.payload.block === block.id &&
        block.optionalInputs?.includes(e.payload.root)
      )
        roots.add(e.payload.root);
    return [...roots];
  }
  ownOutputs() {
    const ids = new Set<string>();
    for (const e of this.events())
      if (e.author === this.who.publicKey) {
        if (e.payload.kind === "result") ids.add(e.payload.artifact);
        if (e.payload.kind === "verification") ids.add(e.payload.report);
      }
    return ids;
  }
  subscribe(id: string) {
    this.db
      .query("INSERT OR IGNORE INTO settings VALUES (?,?)")
      .run("task:" + id, "1");
  }
  subscriptions(): string[] {
    return (
      this.db
        .query("SELECT key FROM settings WHERE key LIKE 'task:%'")
        .all() as { key: string }[]
    ).map((r) => r.key.slice(5));
  }
  selection(): string[] | undefined {
    const path = join(this.directory, "selection.json");
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : undefined;
  }
  select(blocks: string[] | undefined) {
    if (blocks !== undefined)
      writeFileSync(
        join(this.directory, "selection.json"),
        canonical([...new Set(blocks)]),
        { mode: 0o600 },
      );
  }
  wanted(): Set<string> | undefined {
    const profile = this.participation();
    if (profile?.download === "mirror") return undefined;
    if (profile?.download === "metadata") return new Set<string>();
    const selection =
      profile?.download === "tasks"
        ? (profile.only ?? this.subscriptions())
        : this.selection();
    if (!selection) return undefined;
    const manifest = this.governance().manifest;
    const chosen = new Set(selection);
    const visit = (id: string) => {
      const block = manifest.blocks.find((b) => b.id === id);
      if (block)
        for (const dep of block.requires)
          if (!chosen.has(dep)) {
            chosen.add(dep);
            visit(dep);
          }
    };
    selection.forEach(visit);
    const ids = this.expandRoots(
      manifest.blocks
        .filter((b) =>
          profile?.download === "tasks"
            ? selection.includes(b.id)
            : chosen.has(b.id),
        )
        .flatMap((b) => this.taskInputs(b)),
    );
    const resultIds = new Set<string>();
    for (const e of this.events())
      if (e.payload.kind === "result" && chosen.has(e.payload.block)) {
        ids.add(e.payload.artifact);
        resultIds.add(e.id);
      }
    for (const e of this.events())
      if (e.payload.kind === "verification" && resultIds.has(e.payload.result))
        ids.add(e.payload.report);
    return ids;
  }
  collect() {
    const keep = new Set([
      ...this.governance().manifest.blocks.flatMap((b) => [
        ...b.inputs,
        ...(b.optionalInputs || []),
      ]),
      ...(this.db.query("SELECT id FROM pins").all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ]);
    for (const e of this.events())
      if (
        e.payload.kind === "control" &&
        e.payload.action.type === "accounting"
      )
        keep.add(e.payload.action.archive);
    for (const e of this.events()) {
      if (e.payload.kind === "result") keep.add(e.payload.artifact);
      if (e.payload.kind === "verification") keep.add(e.payload.report);
    }
    for (const id of [...keep]) {
      const bytes = this.blob(id);
      if (bytes)
        try {
          const index = JSON.parse(Buffer.from(bytes).toString());
          if (index.type === "bitswarm.file.v1" && Array.isArray(index.chunks))
            index.chunks.filter(isHash).forEach((h: string) => keep.add(h));
        } catch {}
    }
    let removed = 0;
    this.db.transaction(() => {
      for (const id of this.inventory().blobs)
        if (!keep.has(id)) {
          this.db.query("DELETE FROM blobs WHERE id=?").run(id);
          this.db.query("DELETE FROM blob_owners WHERE id=?").run(id);
          removed++;
        }
    })();
    return { removed, retained: keep.size };
  }
  scoreboard() {
    const points = new Map<string, number>();
    for (const s of this.state())
      if (s.accepted)
        points.set(s.accepted.author, (points.get(s.accepted.author) || 0) + 1);
    return [...points]
      .map(([author, acceptedBlocks]) => ({ author, acceptedBlocks }))
      .sort(
        (a, b) =>
          b.acceptedBlocks - a.acceptedBlocks ||
          a.author.localeCompare(b.author),
      );
  }
  rememberPeer(address: string) {
    this.db
      .query("INSERT OR IGNORE INTO peers(address) VALUES (?)")
      .run(address);
  }
  peers(): string[] {
    return availablePeers(this.db);
  }
  static savedPeers(directory: string, swarm: string): string[] {
    const manifest = join(directory, "manifest.json"),
      database = join(directory, "swarm.sqlite");
    if (!existsSync(manifest) || !existsSync(database)) return [];
    if (digest(JSON.parse(readFileSync(manifest, "utf8"))) !== swarm) return [];
    const db = new Database(database, { readonly: true });
    try {
      if (
        !db
          .query(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='peers'",
          )
          .get()
      )
        return [];
      return availablePeers(db);
    } finally {
      db.close();
    }
  }
  peerFailure(address: string) {
    this.rememberPeer(address);
    this.db
      .query(
        "UPDATE peers SET failures=failures+1, nextRetry=? WHERE address=?",
      )
      .run(Date.now() + 30_000, address);
  }
  quarantine(peer: string, id: string, reason: string) {
    this.db
      .query(
        "DELETE FROM quarantine WHERE rowid NOT IN (SELECT rowid FROM quarantine ORDER BY rowid DESC LIMIT 1999)",
      )
      .run();
    this.db
      .query(
        "INSERT INTO quarantine(peer,id,reason) VALUES (?,?,?) ON CONFLICT(peer,id) DO UPDATE SET attempts=attempts+1, reason=excluded.reason",
      )
      .run(peer, id, reason.slice(0, 500));
  }
  quarantined(peer: string): Set<string> {
    return new Set(
      (
        this.db
          .query("SELECT id FROM quarantine WHERE peer=? AND attempts>=3")
          .all(peer) as { id: string }[]
      ).map((r) => r.id),
    );
  }
  transfer(key: string, bytes: number) {
    this.db
      .query(
        "INSERT INTO transfer VALUES (?,?) ON CONFLICT(key) DO UPDATE SET bytes=bytes+excluded.bytes",
      )
      .run(key, bytes);
  }
  metrics() {
    return {
      events: this.inventory().events.length,
      objects: this.inventory().blobs.length,
      states: Object.fromEntries(
        [
          "ready",
          "claimed",
          "review",
          "accepted",
          "disputed",
          "blocked",
          "cancelled",
          "exhausted",
        ].map((status) => [
          status,
          this.state().filter((s) => s.status === status).length,
        ]),
      ),
      usage: this.usage(),
      transfers: this.db.query("SELECT * FROM transfer ORDER BY key").all(),
      quarantine: this.db
        .query("SELECT peer,id,reason,attempts FROM quarantine")
        .all(),
      peers: this.peers(),
    };
  }
  trimHistory() {
    const applied = new Set(this.governance().applied);
    for (const e of this.events())
      if (
        applied.has(e.id) &&
        e.payload.kind === "control" &&
        e.payload.action.type === "accounting"
      ) {
        const root = this.blob(e.payload.action.archive);
        if (!root) continue;
        try {
          const index = JSON.parse(Buffer.from(root).toString());
          if (
            index.type !== "bitswarm.file.v1" ||
            !index.chunks.every(this.hasBlob)
          )
            continue;
          this.db.transaction(() => {
            for (const id of e.payload.kind === "control" &&
            e.payload.action.type === "accounting"
              ? e.payload.action.dropped
              : [])
              this.db.query("DELETE FROM events WHERE id=?").run(id);
          })();
        } catch {}
      }
  }
  usage() {
    const active = expenditure(this.governance().manifest, this.events()).get(
      this.who.publicKey,
    ) || { tokens: 0, costMicros: 0 };
    const archived = this.governance().accounted?.get(this.who.publicKey) || {
      tokens: 0,
      costMicros: 0,
    };
    return {
      tokens: active.tokens + archived.tokens,
      costMicros: active.costMicros + archived.costMicros,
    };
  }
  governance() {
    return this.view().g;
  }
  state(now = Date.now()) {
    const g = this.governance();
    return project(g.manifest, this.events(), this.hasBlob, now, {
      ...g,
      readBlob: this.blob.bind(this),
    });
  }
  close() {
    this.db.close();
  }
}
