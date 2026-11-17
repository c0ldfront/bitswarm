import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { identity, type Manifest } from "../src/core.ts";
import { createDialer, startMesh } from "../src/mesh.ts";
import { request } from "../src/network.ts";

async function meshPair() {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-rpc-"));
  const key = identity();
  const manifest: Manifest = {
    version: 4,
    name: "Mesh regressions",
    description: "RPC lifecycle",
    validators: [key.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "part",
        title: "Part",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  const seed = new Store(join(dir, "seed"), manifest);
  const token = crypto.randomUUID();
  const host = await startMesh(seed, token);
  const owner = identity().publicKey;
  const dialer = await createDialer(dir, owner, undefined, [], false, true);
  return {
    dir,
    owner,
    token,
    seed,
    host,
    addr: host.addresses()[0],
    close: async () => {
      await dialer.stop();
      await host.stop();
      seed.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a one-byte mesh payload fits a remaining download budget of one byte", async () => {
  const m = await meshPair();
  try {
    const id = m.seed.addBlob(Buffer.from([9]));
    expect(
      Buffer.from(await request(m.addr, m.token, "/v1/blobs/" + id, {}, 1)),
    ).toEqual(Buffer.from([9]));
  } finally {
    await m.close();
  }
});

test("closing a temporary mesh dialer restores the previous live transport", async () => {
  const m = await meshPair();
  try {
    const overlap = await createDialer(
      m.dir,
      m.owner,
      undefined,
      [],
      false,
      true,
    );
    await overlap.stop();
    expect(
      JSON.parse(
        Buffer.from(await request(m.addr, m.token, "/v1/manifest")).toString(),
      ).name,
    ).toBe("Mesh regressions");
  } finally {
    await m.close();
  }
});

test("aborting a mesh request interrupts a response that has not arrived", async () => {
  const m = await meshPair();
  const entered = Promise.withResolvers<void>();
  let closeRemote: (() => void) | undefined;
  const controller = new AbortController();
  try {
    const protocol = "/bitswarm/rpc/1.0.0";
    await m.host.node.unhandle(protocol);
    await m.host.node.handle(protocol, async (stream) => {
      closeRemote = () => stream.abort(Error("test complete"));
      entered.resolve();
    });
    const result = request(m.addr, m.token, "/v1/manifest", {
      signal: controller.signal,
    }).then(
      () => false,
      () => true,
    );
    await entered.promise;
    controller.abort();
    expect(await Promise.race([result, Bun.sleep(500).then(() => false)])).toBe(
      true,
    );
  } finally {
    closeRemote?.();
    await m.close();
  }
});
