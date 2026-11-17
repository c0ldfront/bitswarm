import { digest } from "./core.ts";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise, pureJsCrypto } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { ping } from "@libp2p/ping";
import { identify, identifyPush } from "@libp2p/identify";
import { mdns } from "@libp2p/mdns";
import { kadDHT } from "@libp2p/kad-dht";
import {
  circuitRelayTransport,
  circuitRelayServer,
} from "@libp2p/circuit-relay-v2";
import { dcutr } from "@libp2p/dcutr";
import { autoNAT } from "@libp2p/autonat";
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import { multiaddr } from "@multiformats/multiaddr";
import { discoveredPeerHints } from "./link.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, MAX_BLOB } from "./core.ts";
import { handle, setMeshTransport } from "./network.ts";
import type { Store } from "./store.ts";
import type { Stream } from "@libp2p/interface";
const protocol = "/bitswarm/rpc/1.0.0";
const maxFrame = 3 * MAX_BLOB;
async function readFrame(stream: Stream): Promise<Buffer> {
  let data = Buffer.alloc(0),
    size: number | undefined;
  for await (const part of stream) {
    data = Buffer.concat([
      data,
      part instanceof Uint8Array
        ? Buffer.from(part)
        : Buffer.from(part.subarray()),
    ]);
    if (size === undefined && data.length >= 4) {
      size = data.readUInt32BE(0);
      assert(size <= maxFrame, "Mesh frame too large");
    }
    assert(data.length <= maxFrame + 4, "Mesh frame too large");
    if (size !== undefined && data.length >= size + 4)
      return data.subarray(4, size + 4);
  }
  throw new Error("Incomplete mesh frame");
}
async function sendFrame(stream: Stream, data: Buffer, signal?: AbortSignal) {
  assert(data.length <= maxFrame, "Mesh frame too large");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const frame = Buffer.concat([header, data]);
  for (let offset = 0; offset < frame.length; offset += 32 * 1024)
    if (!stream.send(frame.subarray(offset, offset + 32 * 1024)))
      await stream.onDrain({ signal: signal ?? AbortSignal.timeout(10_000) });
}
export async function startMesh(
  store: Store,
  token: string,
  options: {
    listen?: string[];
    bootstrap?: string[];
    relay?: boolean;
    lan?: boolean;
    dht?: boolean;
  } = {},
) {
  const keyPath = join(store.directory, "mesh.key");
  const privateKey = existsSync(keyPath)
    ? privateKeyFromProtobuf(readFileSync(keyPath))
    : await generateKeyPair("Ed25519");
  if (!existsSync(keyPath))
    writeFileSync(keyPath, privateKeyToProtobuf(privateKey), {
      mode: 0o600,
      flag: "wx",
    });
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: options.listen || ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise({ crypto: pureJsCrypto })],
    streamMuxers: [yamux()],
    peerDiscovery: options.lan
      ? [
          mdns({
            serviceTag:
              "_bitswarm-" +
              digest(store.manifest).slice(0, 32) +
              "._udp.local",
            interval: 1000,
          }),
        ]
      : [],
    services: {
      ping: ping(),
      identify: identify(),
      identifyPush: identifyPush(),
      dht: kadDHT({
        protocol: "/bitswarm/kad/" + digest(store.manifest) + "/1.0.0",
        clientMode: !options.dht,
        peerInfoMapper: (peer) => peer,
      }),
      dcutr: dcutr(),
      autoNAT: autoNAT(),
      ...(options.relay
        ? {
            relay: circuitRelayServer({
              reservations: { maxReservations: 32 },
            }),
          }
        : {}),
    },
    connectionManager: { maxConnections: 64 },
  });
  await node.handle(
    protocol,
    async (stream) => {
      stream.inactivityTimeout = 10_000;
      try {
        const wire = JSON.parse((await readFrame(stream)).toString());
        assert(
          typeof wire.path === "string" &&
            wire.path.startsWith("/v1/") &&
            ["GET", "PUT"].includes(wire.method) &&
            typeof wire.body === "string" &&
            wire.body.length <= 2 * MAX_BLOB,
          "Invalid mesh RPC",
        );
        const body = Buffer.from(wire.body, "base64");
        const response = await handle(
          store,
          token,
          new Request("http://mesh" + wire.path, {
            method: wire.method,
            headers: wire.headers,
            ...(wire.method === "PUT" ? { body } : {}),
          }),
        );
        await sendFrame(
          stream,
          Buffer.from(
            JSON.stringify({
              status: response.status,
              body: Buffer.from(await response.arrayBuffer()).toString(
                "base64",
              ),
            }),
          ),
        );
        await stream.close();
      } catch (e) {
        store.quarantine(
          "mesh-rpc",
          crypto.randomUUID(),
          e instanceof Error ? e.message : "Invalid RPC",
        );
        stream.abort(e instanceof Error ? e : new Error("Invalid RPC"));
      }
    },
    {
      maxInboundStreams: 32,
      maxOutboundStreams: 32,
      runOnLimitedConnection: true,
    },
  );
  const transport = rpcTransport(node);
  const removeOwner = setMeshTransport(transport, store.who.publicKey);
  const removeDefault = setMeshTransport(transport);
  node.addEventListener("peer:discovery", (event) => {
    for (const hint of discoveredPeerHints(
      event.detail.multiaddrs,
      event.detail.id.toString(),
    )) {
      try {
        store.rememberPeer(hint);
      } catch {}
    }
  });
  for (const address of options.bootstrap || []) {
    store.rememberPeer("libp2p:" + address.replace(/^libp2p:/, ""));
    try {
      await node.dial(multiaddr(address.replace(/^libp2p:/, "")), {
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      store.peerFailure("libp2p:" + address.replace(/^libp2p:/, ""));
    }
  }
  const announce = () =>
    node.contentRouting
      .provide(
        CID.createV1(
          0x55,
          Digest.create(0x12, Buffer.from(digest(store.manifest), "hex")),
        ),
      )
      .catch(() => {});
  const announcement = setInterval(announce, 30_000);
  void announce();
  return {
    node,
    transport,
    addresses: () => node.getMultiaddrs().map((a) => "libp2p:" + a.toString()),
    stop: async () => {
      clearInterval(announcement);
      removeOwner();
      removeDefault();
      await node.stop();
    },
  };
}

function rpcTransport(node: Pick<Libp2p, "dialProtocol">) {
  return async (peer: string, path: string, init: RequestInit, max: number) => {
    const timeout = AbortSignal.timeout(10_000);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    signal.throwIfAborted();
    const stream = await node.dialProtocol(
      multiaddr(peer.slice("libp2p:".length)),
      protocol,
      { signal, runOnLimitedConnection: true },
    );
    const abort = () =>
      stream.abort(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Mesh request aborted"),
      );
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const body =
        typeof init.body === "string"
          ? Buffer.from(init.body)
          : init.body instanceof Uint8Array
            ? Buffer.from(init.body)
            : Buffer.alloc(0);
      const frame = Buffer.from(
        JSON.stringify({
          path,
          method: init.method || "GET",
          headers: init.headers,
          body: body.toString("base64"),
        }),
      );
      const [response] = await Promise.all([
        readFrame(stream),
        sendFrame(stream, frame, signal),
      ]);
      const wire = JSON.parse(response.toString());
      assert(
        wire.status >= 200 && wire.status < 300,
        `Mesh peer returned ${wire.status}`,
      );
      assert(
        typeof wire.body === "string" &&
          wire.body.length <= Math.ceil(max / 3) * 4,
        "Mesh response too large",
      );
      const data = Buffer.from(wire.body, "base64");
      assert(data.length <= max, "Mesh response too large");
      await stream.close({ signal });
      return data;
    } catch (e) {
      stream.abort(e instanceof Error ? e : new Error("Mesh request failed"));
      signal.throwIfAborted();
      throw e;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}

export async function createDialer(
  directory: string,
  owner: string,
  swarm?: string,
  bootstrap: string[] = [],
  lan = false,
  ephemeral = false,
) {
  const keyPath = join(directory, "mesh.key");
  const privateKey =
    !ephemeral && existsSync(keyPath)
      ? privateKeyFromProtobuf(readFileSync(keyPath))
      : await generateKeyPair("Ed25519");
  if (!ephemeral && !existsSync(keyPath))
    writeFileSync(keyPath, privateKeyToProtobuf(privateKey), {
      mode: 0o600,
      flag: "wx",
    });
  const node = await createLibp2p({
    privateKey,
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise({ crypto: pureJsCrypto })],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        protocol: "/bitswarm/kad/" + swarm + "/1.0.0",
        clientMode: true,
        peerInfoMapper: (peer) => peer,
      }),
    },
    peerDiscovery: lan
      ? [
          mdns({
            serviceTag: "_bitswarm-" + swarm?.slice(0, 32) + "._udp.local",
            interval: 1000,
          }),
        ]
      : [],
  });
  const transport = rpcTransport(node);
  const removeOwner = setMeshTransport(transport, owner);
  const removeDefault = setMeshTransport(transport);
  const discovered = new Set<string>();
  node.addEventListener("peer:discovery", (event) => {
    for (const hint of discoveredPeerHints(
      event.detail.multiaddrs,
      event.detail.id.toString(),
    ))
      discovered.add(hint);
  });
  for (const address of bootstrap)
    try {
      await node.dial(multiaddr(address.replace(/^libp2p:/, "")), {
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  return {
    findPeers: async () => {
      if (lan) await Bun.sleep(2000);
      if (swarm && (!lan || !discovered.size))
        try {
          for await (const provider of node.contentRouting.findProviders(
            CID.createV1(0x55, Digest.create(0x12, Buffer.from(swarm, "hex"))),
            { signal: AbortSignal.timeout(5000) },
          ))
            for (const hint of discoveredPeerHints(
              provider.multiaddrs,
              provider.id.toString(),
            ))
              discovered.add(hint);
        } catch {}
      return [...discovered];
    },
    stop: async () => {
      removeOwner();
      removeDefault();
      await node.stop();
    },
  };
}
