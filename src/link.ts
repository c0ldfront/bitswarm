import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import { assert, isHash } from "./core.ts";

// A swarm URI identifies an immutable work manifest. Peers are replaceable
// bootstrap hints, never the authority for the identity of the work.
export type SwarmLink = { swarm: string; name?: string; peers: string[] };
export function discoveredPeerHints(
  addresses: Multiaddr[],
  peerId: string,
): string[] {
  return addresses.flatMap((address) => {
    // The binary form normalizes CID and base58 spellings of the same peer ID.
    const canonical = multiaddr(address.bytes);
    const destination = canonical.getComponents().at(-1);
    if (destination?.name === "p2p")
      return destination.value === peerId ? ["libp2p:" + canonical] : [];
    return ["libp2p:" + canonical.encapsulate("/p2p/" + peerId)];
  });
}
export function peerOrigin(peer: string): string {
  if (peer.startsWith("libp2p:")) {
    const address = multiaddr(multiaddr(peer.slice(7)).bytes);
    assert(
      address.getComponents().at(-1)?.name === "p2p",
      "Mesh peer address needs a destination peer ID",
    );
    return "libp2p:" + address.toString();
  }
  const url = new URL(peer);
  assert(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Peer must be an HTTP(S) origin",
  );
  return url.origin;
}
export function formatSwarmLink(link: SwarmLink): string {
  assert(isHash(link.swarm), "Invalid swarm hash");
  assert(link.peers.length <= 16, "At most 16 bootstrap peers");
  assert(
    link.name === undefined ||
      (link.name.length > 0 && link.name.length <= 200),
    "Invalid display name",
  );
  const query = new URLSearchParams({ v: "1" });
  if (link.name) query.set("dn", link.name);
  [...new Set(link.peers.map(peerOrigin))].forEach((peer) =>
    query.append("peer", peer),
  );
  const uri = `swarm://${link.swarm}?${query}`;
  assert(uri.length <= 8192, "Swarm link too long");
  return uri;
}
export function parseSwarmLink(uri: string): SwarmLink {
  assert(uri.length <= 8192, "Swarm link too long");
  const url = new URL(uri);
  assert(
    url.protocol === "swarm:" &&
      isHash(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.pathname &&
      !url.hash,
    "Invalid swarm:// identity",
  );
  const query = url.searchParams;
  assert(
    [...query.keys()].every((k) => ["v", "dn", "peer"].includes(k)),
    "Unknown swarm link parameter",
  );
  assert(
    query.getAll("v").length === 1 && query.get("v") === "1",
    "Unsupported swarm link version",
  );
  assert(query.getAll("dn").length <= 1, "Duplicate display name");
  const name = query.get("dn") ?? undefined;
  assert(
    name === undefined || (name.length > 0 && name.length <= 200),
    "Invalid display name",
  );
  const hints = query.getAll("peer");
  assert(hints.length <= 16, "At most 16 bootstrap peers");
  const peers = [...new Set(hints.map(peerOrigin))];
  return { swarm: url.hostname, ...(name ? { name } : {}), peers };
}
