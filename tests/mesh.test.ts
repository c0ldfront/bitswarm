import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { identity, type Manifest } from "../src/core.ts";
import { startMesh } from "../src/mesh.ts";
import { sync } from "../src/network.ts";
import { credentials } from "../src/access.ts";
import { formatSwarmLink, parseSwarmLink } from "../src/link.ts";
test("Noise-encrypted libp2p peers exchange real artifacts and round-trip swarm links", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-mesh-"));
  const key = identity();
  const manifest: Manifest = {
    version: 1,
    name: "Mesh",
    description: "Mesh transport",
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
  const a = new Store(join(dir, "a"), manifest),
    b = new Store(join(dir, "b"), manifest);
  const token = crypto.randomUUID();
  let ma: Awaited<ReturnType<typeof startMesh>> | undefined,
    mb: Awaited<ReturnType<typeof startMesh>> | undefined;
  try {
    ma = await startMesh(a, token);
    mb = await startMesh(b, token);
    const address = ma.addresses()[0];
    expect(
      parseSwarmLink(
        formatSwarmLink({ swarm: a.inventory().swarm, peers: [address] }),
      ).peers,
    ).toEqual([address]);
    const id = a.addBlob(Buffer.alloc(256 * 1024, 42));
    await sync(b, address, credentials(b, token));
    expect(b.hasBlob(id)).toBe(true);
    const other = b.addBlob(Buffer.from("bidirectional"));
    await sync(a, mb.addresses()[0], credentials(a, token));
    expect(a.hasBlob(other)).toBe(true);
  } finally {
    await ma?.stop();
    await mb?.stop();
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
test("a peer behind a circuit relay serves objects over the relayed route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-relay-")),
    key = identity();
  const manifest: Manifest = {
    version: 1,
    name: "Relay",
    description: "Relayed artifact exchange",
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
  const token = crypto.randomUUID();
  const r = new Store(join(dir, "relay"), manifest),
    a = new Store(join(dir, "a"), manifest),
    b = new Store(join(dir, "b"), manifest);
  let relay: Awaited<ReturnType<typeof startMesh>> | undefined,
    client: Awaited<ReturnType<typeof startMesh>> | undefined,
    target: Awaited<ReturnType<typeof startMesh>> | undefined;
  try {
    relay = await startMesh(r, token, { relay: true });
    const reservation = relay.addresses()[0].slice(7) + "/p2p-circuit";
    target = await startMesh(b, token, { listen: [reservation] });
    client = await startMesh(a, token);
    const address = target.addresses().find((a) => a.includes("/p2p-circuit/"));
    expect(address).toBeDefined();
    const id = b.addBlob(Buffer.from("relayed content"));
    await sync(a, address!, credentials(a, token));
    expect(a.hasBlob(id)).toBe(true);
  } finally {
    await target?.stop();
    await client?.stop();
    await relay?.stop();
    r.close();
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
test("a seedless join discovers a manifest provider through a project DHT router", async () => {
  const { CID } = await import("multiformats/cid");
  const Digest = await import("multiformats/hashes/digest");
  const { createDialer } = await import("../src/mesh.ts");
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-dht-")),
    key = identity();
  const manifest: Manifest = {
    version: 1,
    name: "DHT",
    description: "Provider discovery",
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
  const routerStore = new Store(join(dir, "router"), manifest),
    providerStore = new Store(join(dir, "provider"), manifest);
  const token = crypto.randomUUID();
  let router: Awaited<ReturnType<typeof startMesh>> | undefined,
    provider: Awaited<ReturnType<typeof startMesh>> | undefined,
    dialer: Awaited<ReturnType<typeof createDialer>> | undefined;
  try {
    router = await startMesh(routerStore, token, { dht: true });
    provider = await startMesh(providerStore, token, {
      dht: true,
      bootstrap: [router.addresses()[0]],
    });
    const swarm = providerStore.inventory().swarm;
    const cid = CID.createV1(
      0x55,
      Digest.create(0x12, Buffer.from(swarm, "hex")),
    );
    await provider.node.contentRouting.provide(cid, {
      signal: AbortSignal.timeout(5000),
    });
    const clientPath = join(dir, "client");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(clientPath);
    dialer = await createDialer(clientPath, identity().publicKey, swarm, [
      router.addresses()[0],
    ]);
    const peers = await dialer.findPeers();
    expect(
      peers.some((p) => p.includes(provider!.node.peerId.toString())),
    ).toBe(true);
  } finally {
    await dialer?.stop();
    await provider?.stop();
    await router?.stop();
    routerStore.close();
    providerStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
const lanIntegration = process.env.BITSWARM_TEST_LAN === "1" ? test : test.skip;
lanIntegration(
  "a seedless participant discovers its project through local multicast",
  async () => {
    const { createDialer } = await import("../src/mesh.ts");
    const { mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "bitswarm-lan-")),
      key = identity();
    const manifest: Manifest = {
      version: 2,
      name: "LAN",
      description: "Local discovery",
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
    const source = new Store(join(dir, "source"), manifest);
    let server: Awaited<ReturnType<typeof startMesh>> | undefined,
      dialer: Awaited<ReturnType<typeof createDialer>> | undefined;
    try {
      server = await startMesh(source, crypto.randomUUID(), {
        lan: true,
        listen: ["/ip4/0.0.0.0/tcp/0"],
      });
      const path = join(dir, "client");
      mkdirSync(path);
      dialer = await createDialer(
        path,
        identity().publicKey,
        source.inventory().swarm,
        [],
        true,
      );
      const peers = await dialer.findPeers();
      expect(
        peers.some((p) => p.includes(server!.node.peerId.toString())),
      ).toBe(true);
    } finally {
      await dialer?.stop();
      await server?.stop();
      source.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
