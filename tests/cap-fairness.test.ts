import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, identity, type Manifest } from "../src/core.ts";
import { handle, serve, sync } from "../src/network.ts";
import { Store } from "../src/store.ts";

// Hash order places more than one batch of unaffordable objects before the
// only byte that either transfer direction can afford.
const small = Buffer.from([255]);
const large: Buffer[] = [];
for (let n = 0; large.length < 101; n++) {
  const body = Buffer.from("sample " + n);
  if (hash(body) < hash(small)) large.push(body);
}
const token = "cap-fairness-token-aaaaaaaaaaaaaaaaa";
for (const direction of ["pull", "push"] as const) {
  for (const limited of ["sender", "receiver"] as const) {
    test(
      direction +
        " can transfer a later affordable object with a " +
        limited +
        " cap",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "bitswarm-fair-"));
        const key = identity().publicKey;
        const m: Manifest = {
          version: 4,
          name: "Transfer fairness",
          description: "Capped mirror",
          validators: [key],
          quorum: 1,
          blocks: [
            {
              id: "x",
              title: "X",
              instructions: "Test transfer",
              inputs: [],
              requires: [],
              capabilities: [],
            },
          ],
        };
        const sender = new Store(join(dir, "sender"), m),
          receiver = new Store(join(dir, "receiver"), m);
        const server = serve(
          direction === "pull" ? sender : receiver,
          token,
          0,
        );
        try {
          for (const body of [...large, small]) sender.addBlob(body);
          if (limited === "sender")
            sender.configure({
              download: "mirror",
              upload: "cache",
              uploadBytes: 1,
            });
          else
            receiver.configure({
              download: "mirror",
              upload: "cache",
              downloadBytes: 1,
            });
          const result = await sync(
            direction === "pull" ? receiver : sender,
            server.url.origin,
            token,
          );
          expect(receiver.inventory().blobs).toEqual([hash(small)]);
          expect(result.invalid).toBe(0);
          expect(receiver.usedBytes("download")).toBe(1);
          expect(sender.usedBytes("upload")).toBe(1);
        } finally {
          server.stop(true);
          sender.close();
          receiver.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }
}

test("legacy inventories without size hints continue past a full rejected batch after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-legacy-cap-"));
  const m: Manifest = {
    version: 3,
    name: "Older peer",
    description: "Legacy inventory",
    validators: [identity().publicKey],
    quorum: 1,
    blocks: [
      {
        id: "x",
        title: "X",
        instructions: "Test",
        inputs: [],
        requires: [],
        capabilities: [],
      },
    ],
  };
  const source = new Store(join(dir, "source"), m),
    path = join(dir, "receiver");
  let receiver = new Store(path, m);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const res = await handle(source, token, req);
      if (new URL(req.url).pathname !== "/v1/inventory") return res;
      const page = await res.json();
      delete page.tooLarge;
      return Response.json(page);
    },
  });
  try {
    for (const data of [...large, small]) source.addBlob(data);
    receiver.configure({
      download: "mirror",
      upload: "results",
      downloadBytes: 1,
    });
    await sync(receiver, server.url.origin, token);
    expect(receiver.hasBlob(hash(small))).toBe(false);
    receiver.close();
    receiver = new Store(path);
    await sync(receiver, server.url.origin, token);
    expect(receiver.inventory().blobs).toEqual([hash(small)]);
  } finally {
    server.stop(true);
    source.close();
    receiver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
