# swarm:// descriptor v1

```text
swarm://<manifest-sha256>?v=1[&dn=<display-name>][&peer=<encoded-peer>]...
```

The authority is a lowercase 64-digit SHA-256 of the immutable genesis manifest. The query contains exactly one `v=1`, an optional UTF-8 `dn` display hint of up to 200 characters, and up to 16 `peer` hints. Standard URL query encoding applies. URIs are bounded to 8,192 characters. Credentials, authority ports, paths, fragments, unknown parameters and ambiguous singleton parameters are rejected.

Peer hints may be HTTP(S) origins without credentials/query/fragment/non-root paths, or `libp2p:` followed by a multiaddress containing a peer ID. Examples:

```text
https://seed.example:7331
libp2p:/ip4/192.0.2.1/tcp/7333/p2p/PEER_ID
libp2p:/ip4/192.0.2.1/tcp/7333/p2p/RELAY_ID/p2p-circuit/p2p/DESTINATION_ID
```

Actual peer IDs are printed by `mesh`; placeholders above are not working addresses. Encode the entire peer value with `URLSearchParams`. `share --peer URL` performs validation, encoding and deduplication.

Joining validates the descriptor, collects explicit peers before embedded hints, fetches a genesis manifest, verifies its canonical hash, checks the manifest schema, then exchanges metadata and needed objects. Failed peers or manifests with another hash are skipped in favor of the next hint. The display name grants no authority.

```sh
bun run swarm share --state .swarm/owner --peer https://seed.example
bun run swarm join --state .swarm/worker '<printed URI>'
bun run swarm join --state .swarm/worker --link 'swarm://HASH?v=1' --peer https://seed.example
```

A libp2p hint starts an ephemeral dialer during CLI joining. A seedless descriptor can use `--bootstrap MULTIADDR` to find DHT providers, or `--lan` to discover project peers through mDNS. There must still be some reachable routing or LAN peer. The repository does not deploy a global bootstrap service.

Bearer tokens remain in `BITSWARM_TOKEN`. Private contributor grants use `--invite FILE` and the local identity that the owner admitted. Pinned reviewers with an existing identity can use `--signed`. A descriptor identifies work; it is neither an access credential nor permission to run peer-supplied executables.

`install-handler --register` offers Linux desktop registration for `x-scheme-handler/swarm`. `install-handler --output DIR` generates a reviewable desktop entry without registering it. `open URI` chooses a project-specific state directory under `BITSWARM_STATE_ROOT` or `~/.local/share/bitswarm`. Credentials must be configured separately. Tests exercise generation without changing the user's desktop preferences.

Authorized signed project controls can add blocks, recover the planner, change policy or checkpoint findings while preserving the genesis identity. Editing the genesis manifest itself creates a different swarm.

Protocol 3 public projects can be joined without a shared bearer secret: the CLI uses its local identity and a bounded request-work proof when no token or invitation is configured. `--public --workBits N` selects an explicit admission difficulty. Existing saved invitations are reused automatically. Private projects still require a valid invitation or an authorized reviewer identity. Signed protocol 3 requests bind the target swarm, preventing a proof captured for one project from authorizing another.

A fresh CLI join starts in task download mode with an empty subscription set. Opening the same link with `preview` shows advertised information before joining. An operator can request a mirror independently from serving cached payloads. See [RFC 0001](rfc-0001.md).
