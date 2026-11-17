import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digest,
  hash,
  makeEvent,
  MAX_BLOB,
  type Manifest,
} from "../src/core.ts";
import { Store } from "../src/store.ts";
import { serve, sync, getManifest } from "../src/network.ts";
import { claim, packet, runWorker } from "../src/worker.ts";
import { fixture } from "./core.test.ts";

const token = "a-test-token-with-at-least-32-characters";
test("three live peers converge across seed loss, restart, bad input and artifact transfer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-test-"));
  const { manifest } = fixture();
  const a = new Store(join(dir, "a"), manifest),
    b = new Store(join(dir, "b"), manifest),
    c = new Store(join(dir, "c"), manifest);
  const sa = serve(a, token, 0),
    sb = serve(b, token, 0),
    sc = serve(c, token, 0);
  try {
    const bytes = Buffer.from("an application artifact");
    const id = a.addBlob(bytes);
    const event = makeEvent(manifest, a.who, {
      kind: "claim",
      block: "root",
      expires: Date.now() + 60_000,
      dependencies: [],
    });
    a.addEvent(event);
    expect(digest(await getManifest(sa.url.toString(), token))).toBe(
      digest(manifest),
    );
    await sync(b, sa.url.toString(), token);
    expect(b.event(event.id)).toBeDefined();
    expect(hash(b.blob(id)!)).toBe(id);
    sa.stop(true); // Original seed gone; a third node can still join through B.
    await sync(c, sb.url.toString(), token);
    expect(c.inventory()).toEqual(b.inventory());
    const reply = await fetch(new URL("/v1/inventory", sb.url));
    expect(reply.status).toBe(401);
    await expect(sync(c, sb.url.toString(), "wrong")).rejects.toThrow();
    const bad = await fetch(new URL("/v1/blobs/" + hash("wrong"), sb.url), {
      method: "PUT",
      headers: { authorization: "Bearer " + token },
      body: "tampered",
    });
    expect(bad.status).toBe(400);
    expect(() => b.addBlob(new Uint8Array(MAX_BLOB + 1))).toThrow();
    const forged = { ...event, author: c.who.publicKey };
    expect(() => b.addEvent(forged)).toThrow();
    b.close();
    const reopened = new Store(join(dir, "b"));
    expect(reopened.event(event.id)).toBeDefined();
    expect(reopened.blob(id)).toEqual(bytes);
    reopened.close();
  } finally {
    sa.stop(true);
    sb.stop(true);
    sc.stop(true);
    a.close();
    c.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("worker subprocess consumes evidence and publishes a result; downstream receives only its declared sources and dependency artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-worker-"));
  const { manifest } = fixture();
  const source = Buffer.from("owner supplied fixture");
  const sourceHash = hash(source);
  const m: Manifest = {
    ...manifest,
    blocks: manifest.blocks.map((b) => ({
      ...b,
      inputs: b.id === "root" ? [sourceHash] : [],
    })),
  };
  const store = new Store(dir, m);
  store.addBlob(source);
  try {
    const result = await runWorker(store, ["bun", "examples/adapter.ts"]);
    expect(result?.payload.kind).toBe("result");
    expect(store.state()[0].status).toBe("review");
    const e = makeEvent(m, store.who, {
      kind: "claim",
      block: "child",
      expires: Date.now() + 10000,
      dependencies: [result!.id],
    });
    store.addEvent(e);
    expect(packet(store, e.id).sources).toEqual([]);
    expect(packet(store, e.id).dependencies[0].result).toBe(result!.id);
    const claimStore = new Store(join(dir, "other"), m);
    claimStore.addBlob(source);
    await expect(
      runWorker(claimStore, ["bun", "-e", 'console.log("invalid json")']),
    ).rejects.toThrow();
    expect(claimStore.state()[0].status).toBe("ready");
    claimStore.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
