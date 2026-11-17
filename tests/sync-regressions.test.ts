import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { compact } from "../src/operations.ts";
import { control } from "../src/control.ts";
import { identity, makeEvent, type Manifest } from "../src/core.ts";
import { claim } from "../src/worker.ts";
import { serve, request, sync, hydrateTask, handle } from "../src/network.ts";

const planner = identity();
const token = "ordinary-local-regression-test-credentials";
function fixture(): Manifest {
  return {
    version: 4,
    name: "Synchronization regressions",
    description: "Independent replicas",
    validators: [planner.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "first",
        title: "First",
        instructions: "Find the first result",
        inputs: [],
        requires: [],
        capabilities: [],
      },
    ],
  };
}

test("out-of-order accounting records wait for their signed control parent before physical pruning", () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-accounting-parent-"));
  const a = new Store(join(dir, "owner"), fixture());
  const b = new Store(join(dir, "replica"), a.manifest);
  try {
    const original = claim(a, "first");
    a.addEvent(
      makeEvent(a.manifest, a.who, {
        kind: "failure",
        claim: original.id,
        reason: "No result",
        retryable: true,
      }),
    );
    a.who = planner;
    const parent = control(a, { type: "cancel", block: "first" });
    expect(compact(a).removed).toBe(2);
    const summary = a
      .events()
      .find(
        (e) =>
          e.payload.kind === "control" &&
          e.payload.action.type === "accounting",
      )!;
    b.addEvent(original);
    for (const id of a.inventory().blobs) b.addBlob(a.blob(id)!, id);
    b.addEvent(summary);
    b.trimHistory();
    expect(b.event(original.id)?.id).toBe(original.id);
    b.addEvent(parent);
    b.trimHistory();
    expect(
      b.db.query("SELECT id FROM events WHERE id=?").get(original.id),
    ).toBeNull();
  } finally {
    b.close();
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each serving replica enforces its own per-contributor request quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-rate-scope-"));
  const m = fixture();
  m.policy = { requestsPerMinute: 1 };
  const a = new Store(join(dir, "a"), m),
    b = new Store(join(dir, "b"), m);
  const first = serve(a, token, 0),
    second = serve(b, token, 0);
  try {
    await request(first.url.origin, token, "/v1/manifest");
    await expect(
      request(first.url.origin, token, "/v1/manifest"),
    ).rejects.toThrow("429");
    expect(
      JSON.parse(
        Buffer.from(
          await request(second.url.origin, token, "/v1/manifest"),
        ).toString(),
      ),
    ).toEqual(m);
  } finally {
    first.stop(true);
    second.stop(true);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled hydration stops an in-flight inventory request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-sync-cancel-"));
  const store = new Store(dir, fixture(), {
    download: "tasks",
    upload: "results",
  });
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      started.resolve();
      await release.promise;
      return new Response();
    },
  });
  const stop = new AbortController();
  try {
    store.rememberPeer(server.url.origin);
    const pending = hydrateTask(store, "first", () => false, stop.signal);
    await started.promise;
    stop.abort(new Error("Stop job"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          pending,
          new Promise<void>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Caller still waiting")),
              1000,
            );
          }),
        ]),
      ).rejects.toThrow("Stop job");
    } finally {
      clearTimeout(timer);
      release.resolve();
      await pending.catch(() => {});
    }
    expect(store.usedBytes("download")).toBe(0);
  } finally {
    release.resolve();
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running sync honors a contributor switching to metadata-only downloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-change-download-")),
    a = new Store(join(dir, "seed"), fixture()),
    b = new Store(join(dir, "replica"), a.manifest, {
      download: "mirror",
      upload: "cache",
    });
  let served = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (
        new URL(req.url).pathname.startsWith("/v1/blobs/") &&
        req.method === "GET"
      ) {
        served++;
        if (served === 1)
          b.configure({ download: "metadata", upload: "cache" });
      }
      return handle(a, token, req);
    },
  });
  try {
    for (const content of ["one", "two", "three"])
      a.addBlob(Buffer.from(content));
    await sync(b, server.url.origin, token);
    expect(served).toBe(1);
    expect(b.inventory().blobs).toHaveLength(0);
    expect(b.usedBytes("download")).toBe(0);
  } finally {
    server.stop(true);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching to results-only prevents pending cache pushes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-change-upload-")),
    a = new Store(join(dir, "seed"), fixture()),
    b = new Store(join(dir, "replica"), a.manifest, {
      download: "mirror",
      upload: "cache",
    });
  let received = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (
        new URL(req.url).pathname.startsWith("/v1/blobs/") &&
        req.method === "PUT"
      ) {
        received++;
        if (received === 1)
          b.configure({ download: "mirror", upload: "results" });
      }
      return handle(a, token, req);
    },
  });
  try {
    for (const content of ["one", "two", "three"])
      b.addBlob(Buffer.from(content));
    await sync(b, server.url.origin, token);
    expect(received).toBe(1);
    expect(a.inventory().blobs).toHaveLength(1);
  } finally {
    server.stop(true);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
