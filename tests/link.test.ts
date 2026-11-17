import { test, expect } from "bun:test";
import { digest } from "../src/core.ts";
import { multiaddr } from "@multiformats/multiaddr";
import {
  discoveredPeerHints,
  formatSwarmLink,
  parseSwarmLink,
  peerOrigin,
} from "../src/link.ts";
const swarm = digest({ project: "application" });
test("swarm:// round trips hash, Unicode name and multiple bootstrap origins", () => {
  const link = {
    swarm,
    name: "逆解析 & interfaces",
    peers: ["https://seed.example:7331", "http://127.0.0.1:7332"],
  };
  const uri = formatSwarmLink(link);
  expect(uri.startsWith("swarm://" + swarm + "?v=1")).toBe(true);
  expect(parseSwarmLink(uri)).toEqual(link);
});
test("seedless links work with separately supplied bootstrap hints", () => {
  expect(parseSwarmLink(formatSwarmLink({ swarm, peers: [] }))).toEqual({
    swarm,
    peers: [],
  });
});
test("canonicalize and deduplicate bootstrap origins", () => {
  expect(
    parseSwarmLink(
      formatSwarmLink({
        swarm,
        peers: ["https://SEED.example/", "https://seed.example"],
      }),
    ).peers,
  ).toEqual(["https://seed.example"]);
});
test("reject malformed identities, ambiguous versions, credentials and unsafe peer schemes", () => {
  const invalid = [
    `https://${swarm}?v=1`,
    `swarm://bad?v=1`,
    `swarm://${swarm}/path?v=1`,
    `swarm://user@${swarm}?v=1`,
    `swarm://${swarm}:7331?v=1`,
    `swarm://${swarm}?v=2`,
    `swarm://${swarm}?v=1&v=1`,
    `swarm://${swarm}?v=1#secret`,
    `swarm://${swarm}?v=1&token=secret`,
    `swarm://${swarm}?v=1&peer=file:///etc/passwd`,
    `swarm://${swarm}?v=1&peer=https://user:secret@seed.example`,
  ];
  for (const uri of invalid) expect(() => parseSwarmLink(uri)).toThrow();
});
test("enforce bounded URI and bootstrap counts", () => {
  expect(() =>
    parseSwarmLink("swarm://" + swarm + "?v=1&dn=" + "a".repeat(8192)),
  ).toThrow();
  expect(() =>
    formatSwarmLink({
      swarm,
      peers: Array.from({ length: 17 }, (_, i) => `https://seed${i}.example`),
    }),
  ).toThrow();
});

test("relayed discovery adds the destination identity and produces a dialable swarm link", () => {
  const relay = "12D3KooWFVELyVF3KdDrJCDAEqWYuKiSWwxTi8AmhEmHZ627Bdyp";
  const destination = "12D3KooWMhDnBTbEt3f6ZFyeBgJ7SnuPjWqWNpnMT7pNpSL4pEFJ";
  const base = "/ip4/127.0.0.1/tcp/4001";
  const route = base + "/p2p/" + relay + "/p2p-circuit";
  const complete = route + "/p2p/" + destination;
  const hints = discoveredPeerHints(
    [multiaddr(route), multiaddr(base)],
    destination,
  );
  expect(
    parseSwarmLink(formatSwarmLink({ swarm, peers: hints })).peers,
  ).toEqual(["libp2p:" + complete, "libp2p:" + base + "/p2p/" + destination]);
  expect(discoveredPeerHints([multiaddr(complete)], destination)).toEqual([
    "libp2p:" + complete,
  ]);
  const cid =
    "bafzaajaiaejcbmdxwer65jdlwoihhb7cgja6gpyvw6t7dldly4wo4yennslqpsrz";
  const cidRoute = route + "/p2p/" + cid;
  expect(discoveredPeerHints([multiaddr(cidRoute)], destination)).toEqual([
    "libp2p:" + complete,
  ]);
  expect(peerOrigin("libp2p:" + cidRoute)).toBe("libp2p:" + complete);
  expect(discoveredPeerHints([multiaddr(complete)], relay)).toEqual([]);
  expect(() => peerOrigin("libp2p:" + route)).toThrow("destination peer ID");
});
