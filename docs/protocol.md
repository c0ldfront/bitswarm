# BitSwarm protocol and trust model

[Protocol RFC 0001](rfc-0001.md) specifies protocol 4 and current participation defaults.

## Identity and compatibility

The immutable genesis manifest hashes to the swarm ID. Manifest versions 1, 2, 3 and 4 are accepted; emitters use the manifest version on signed events. Version 2 projects use the earlier lifecycle. Protocol 3 adds public work-priced admission, recipe pins, independent verification thresholds, accounting compaction and optional credits. Protocol 4 adds optional input requests and restricted projects. Readers reject unsupported manifest versions. The `swarm://` descriptor remains version 1 because its hash-and-bootstrap-hints encoding is unchanged. Clients that only understand the original task events cannot participate fully in version 2 projects.

Canonical JSON recursively sorts object keys and uses JavaScript JSON scalar encoding. SHA-256 identifies raw objects and canonical signed event envelopes. This implementation does not claim RFC 8785 interoperability across languages. Public identities use canonical base64 Ed25519 SPKI DER; noncanonical key encodings are rejected. Private keys never appear on the wire.

## Records

All events include version, swarm, author, millisecond timestamp, nonce, payload, Ed25519 signature and SHA-256 event ID. The signature covers the canonical envelope without signature/ID; the ID covers the canonical envelope plus signature. Admission checks schema, signature, swarm, size and bounded future clock skew. References can arrive out of order.

| Kind         | Purpose                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| claim        | Block, lease expiration, accepted dependency receipts                       |
| renew        | Extend an owned live lease within the block execution deadline              |
| failure      | Release an owned attempt; record conservative reserved usage                |
| result       | Claim reference, artifact hash, summary, usage                              |
| review       | Pinned independent reviewer verdict and explanation                         |
| verification | Pinned independent validator attestation and hashed executable-check report |
| proposal     | A candidate work block and reason                                           |
| control      | Current planner's next authorized project action, with parent control hash  |
| reconcile    | Reviewer vote selecting a control branch at an equivocated parent           |
| recover      | Reviewer vote replacing a lost planner at an agreed parent                  |

## Planner authority

The genesis planner is explicit or defaults to the first reviewer. Control records form a signed parent-linked chain. Actions admit proposed blocks, cancel/resume work, dismiss a result, resolve a dispute, freeze accepted evidence, change policy, admit/revoke contributors, or delegate the planner role. Cycles, duplicate blocks, missing references, invalid policies and unsupported controls halt or reject the proposed action.

At each parent, multiple valid children signed by the authorized planner constitute equivocation. A strict majority of distinct genesis reviewers may reconcile one child. Contradictory votes from the same reviewer contribute nothing. New claims are blocked during an unresolved authority fork. Pinned reviewers retain network access to deliver recovery records in private mode.

A reviewer quorum can recover a lost planner by signing the same `(parent,new key)` pair. The recovery head is a deterministic hash of that pair; later duplicate identical recovery votes do not change it. Reviewer-authorized recovery takes priority over a continuation at the specified parent. Reviewers should recover the agreed current head; voting for an earlier head can supersede its continuation. This is explicit project governance, not an irreversible consensus protocol.

Invitations identify their issuing authority head. A receiving node verifies that the issuer was the planner at that head on its current valid control chain, so normal delegation does not invalidate existing grants. Grants from discarded forks do not confer authority.

## Work and acceptance

Tasks form a DAG. Claims cite exact accepted prerequisite result IDs. They are scheduling hints, not distributed exclusive locks; partitions can cause duplicates. Renewal records are applied by causal time and may extend only a still-live lease, capped by task duration. Signed author timestamps are not trusted network time, and an author can backdate a statement. Verification and project review establish acceptance rather than the lease timestamp.

Contracts bound execution duration, attempts and declared usage, optionally requiring JSON Schema output and a named executable verifier. Reviewers choose their verifier executables locally; remote statements never select local commands. A report records the result, verifier name, bundled recipe hash, duration and named checks. Protocol 3 defaults the verification threshold to the project quorum. An explicit verifierHash pins the bundled entrypoint and imported helpers; it is not a proof of every external runtime dependency. Acceptance requires available output, schema compliance, usage within contract, passing independent verifier reports meeting the configured threshold when requested, and independent reviewer quorum. Checks and reviews are statements by trusted keys, not proof that a malicious reviewer ran the claimed executable.

Repeated identical verdicts count once. Contradictory verdicts disqualify that reviewer for the candidate. Failed executable verification rejects the candidate. Pending reviews expire and release work. Exhausted attempts require a planner resume/retry. Blocks may be blocked, ready, claimed, in review, accepted, disputed, cancelled or exhausted.

Distinct accepted artifacts dispute the block and stop dependents. A planner may resolve a dispute by selecting an already approved candidate. Checkpoint records select accepted results and freeze specific review/verification evidence. The CLI checkpoints each new accepted result separately using bounded, deduplicated proofs. Later contradictory reviews do not change that snapshot. Missing artifacts still prevent replay; authority-chain reconciliation or recovery can supersede controls. Checkpoints therefore provide a trusted project baseline rather than Byzantine finality.

Artifact possession is separate from acceptance: a node can recognize a verified upstream result without holding every original input byte. It still needs the selected task's complete source chunks before executing it.

## Access and budgets

Legacy/team mode uses a shared bearer token. Private invitation mode requires an Ed25519-signed request binding the method, path/query, raw-body hash, current time, nonce and optional contributor grant. Grants bind the swarm, subject public key, role, expiry and issuing authority. Nonces are stored temporarily to reject replay. Readers cannot upload; worker/reviewer records remain constrained by the manifest's author and quorum rules. Contributor admission alone never changes the voting committee.

Revocations affect nodes after the signed control chain arrives. Current revocation blocks new network access and uncheckpointed work by that identity. Frozen checkpoints retain their selected evidence. Reviewers remain trusted for original reviews; this version does not rotate the genesis committee in place.

Local claim transactions reserve contract budgets and concurrency. Every spending actor needs an allocation when project limits are finite. Allocation checks include legacy unallocated spending and all unknown attempts, including expired ones. A claim with no reported completion/failure retains its reserve because actual provider spend is unknown. Completed results record provider-reported usage; failed attempts conservatively consume their allocation. Optional contributor allocations are monotonic and cannot sum beyond declared project caps. Revocation does not reclaim potentially spent allocations. This is honest-worker accounting: self-reported usage, unknown provider prices, delayed billing and network partitions prevent a universal hard spending guarantee. Configure provider-side limits too. Accepted contribution counts are informational, not transferable money.

## Transports and persistence

HTTP and the Noise-encrypted libp2p RPC expose the same bounded resource interface:

| Method  | Endpoint                   | Meaning                                                     |
| ------- | -------------------------- | ----------------------------------------------------------- |
| GET     | `/v1/manifest`             | Genesis manifest                                            |
| GET     | `/v1/inventory?type=events | blobs&after=HASH`                                           | Up to 256 sorted IDs and continuation cursor |
| GET     | `/v1/inventory`            | Bounded legacy inventory                                    |
| GET     | `/v1/wants`                | Locally selected artifact IDs, or null for full replication |
| GET     | `/v1/peers`                | Bounded bootstrap hints                                     |
| GET/PUT | `/v1/events/:hash`         | Retrieve or validate/idempotently store a signed record     |
| GET/PUT | `/v1/blobs/:hash`          | Retrieve or hash-check/idempotently store raw bytes         |

Anti-entropy exchanges up to 100 missing events/objects per direction and round. Invalid objects are quarantined independently, so one bad record does not prevent later valid transfers. Repeated failures back off. Peer discovery is opt-in. HTTP redirects are disabled. Bearer secrets are never included in swarm URIs. Use HTTPS for nonlocal HTTP deployments.

Libp2p RPC uses `/bitswarm/rpc/1.0.0` with a 4-byte length prefix and bounded JSON frames carrying status and base64 body. TCP, Noise, Yamux, mDNS, a swarm-scoped Kademlia DHT, circuit relays, AutoNAT and DCUtR are configured through upstream libraries. DHT provider keys are raw-codec CIDs derived from the genesis manifest hash. Discovery requires LAN reachability or an initial routing peer; there is no bundled global service.

SQLite persists events, objects, peer hints, quarantine, accounting and pins. File indexes pin the ordered chunk hashes and full-file SHA-256. Streaming restore verifies each chunk and the full file. Local garbage collection retains referenced/pinned objects; signed history is not compacted. No remote endpoint signs records, executes tools or controls a worker process.

## Limits and evidence

The system trusts the project planner and reviewer committee for governance and semantic judgment. The optional project-credit ledger implements proof-of-work fork choice and confirmation depth, but no financial payment integration, staking market, identity-independence guarantee or audited cryptocurrency security. Work acceptance remains governed by project verifier policy. A malicious invited peer can still consume bounded resources or withhold data. A malicious reviewer majority can accept bad work or authorize harmful project changes.

Tasks and artifacts are untrusted input. Local adapters are explicit executable configurations. Bubblewrap and Docker tool profiles isolate the filesystem/network as documented; ordinary process mode carries ordinary local privileges. Operator-approved tools must be packaged appropriately for the selected runtime. Provider credentials are forwarded only to the configured adapter, not tool subprocesses or peers.

Direct/relayed mesh transfer, DHT provider discovery, invitation/replay/revocation handling, planner forks/recovery, contracts, isolation, worker recovery and the reconstruction workflow have local automated coverage. Successful WAN hole punching, live paid-model quality, arbitrary application reconstruction, public-network adversarial resilience and speedup beyond the included workload are not established by that coverage. See [validation](validation.md).

## Protocol 3 operational records

An `accounting` control references a content-addressed compressed event archive, the exact dropped IDs, per-author usage totals and per-block/authority-epoch attempt counts. Only the current planner can issue it. Compaction retains selected checkpoint results and their causal/verification proofs. Participants logically ignore dropped IDs, including attempts to resurrect them through anti-entropy. Physical rows are removed after the archive chunks exist locally. Accounting summaries are trusted planner assertions backed by an auditable archive; they are not a zero-knowledge cost proof. The control log and essential proofs remain subject to finite project limits.

Encrypted backup format `bitswarm.backup.v1` uses scrypt with a random salt and AES-256-GCM with a random nonce and authenticated format marker, over compressed project data. It includes identity/access files as well as signed records and blobs. Restore validates decryption, hashes, event signatures and schema in a fresh staging directory, then atomically renames it into a new destination. Database user_version 4 is the current local schema; unsupported future versions are rejected without downgrade.

The autonomous coordinator is a local control loop, not a remotely executable job definition. Its operator config selects worker commands, verifier commands and admission bounds. Model-generated proposals are data. Shutdown drains pending synchronization and stops tracked local processes. The default executable-verification boundary is Bubblewrap; Docker is available when the operator provides its runtime image. Ordinary process mode remains an explicit trusted-operator option. The Codex adapter uses the installed CLI's native account authentication, ephemeral sessions, read-only tools and structured output. It does not extract credentials for reuse by arbitrary peers.

## Public admission and optional credit chain

Public requests carry an Ed25519 signature and SHA-256 work over the request body, including swarm identity, HTTP method, path/query, body hash, timestamp and nonce. The server's publicWorkBits sets difficulty. Clients validate the difficulty range and bound their computation time. Replay protection and project quotas still apply; HTTP request quota responses use 429 with Retry-After. This raises admission cost but does not establish independent human identities or Byzantine liveness.

An immutable genesis `credits` configuration selects a fixed difficulty, reward and confirmation depth. A `creditblock` extends a parent ledger block and lists signed `credit-transfer` records. Its proof hashes the entire unsigned event envelope, binding author, swarm, time, nonce and payload. Fixed difficulty makes height proportional to cumulative expected work; equal-height branches use deterministic event-ID ordering. Invalid ancestry, insufficient work, foreign inputs, overspends, duplicate inputs and invalid rewards cannot affect selected balances.

A checkpointed accepted result can receive one contribution reward on a selected branch, paid to the result author. A transfer consumes owned outputs and creates bounded positive outputs; input/output conservation determines its miner fee. Empty blocks can add confirmation work without minting contribution rewards. Transfers use the selected chain's confirmed outputs. Longer valid forks can reorganize balances even after a configured confirmation depth; finality is probabilistic. Governance changes can also change checkpoint eligibility, so these are project-governed, non-monetary credits rather than an independently secured financial asset.

## Current evidence

The live Codex evaluation reconstructed the declared path-processing contract of GNU basename and passed 140 held-out cases. Its single-agent baseline also passed and was faster on this small sequential task. The stress rehearsal completed 180 tasks, 54 offline rounds and 27 seed-server restarts, then converged after healing and compacted 60 history records. See [validation-v3](validation-v3.md) for precise tested surfaces, retained regressions and external validation gaps. Local tests do not establish arbitrary application equivalence, public-network economic security, a sandbox-escape proof or reliable hole punching across every WAN.
