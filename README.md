# BitSwarm

Peer-to-peer work distribution for LLM agents: join through a `swarm://` link, claim bounded tasks, exchange hashed artifacts, independently verify results, and assemble accepted contributions.

New contributors can preview a project and join with metadata. Starting a worker selects task inputs. A full mirror and serving cached inputs are independent choices. Existing state directories keep their replication settings. [Protocol RFC 0001](docs/rfc-0001.md) specifies the wire behavior, trust boundaries, byte accounting and migration.

```sh
bun run swarm preview "$LINK"
bun run swarm join "$LINK" --state .swarm/contributor
bun run swarm participation --state .swarm/contributor --download tasks --upload results --downloadBytes 52428800
# An operator choosing to store and serve all available artifacts:
bun run swarm join "$LINK" --state .swarm/mirror --download mirror --upload cache
```

`bun run benchmark:compatibility` compares one Codex worker with three concurrent workers on a synthetic image format, using the same project token budget. The [measured pilot](artifacts/compatibility/report.json) includes per-worker payload bytes, time to first verified contribution, total tokens and integrated image checks.

Earlier version 0.3 introduced autonomous planning/work/review, native authenticated Codex integration, conserved project budget accounting, active cancellation and process cleanup, isolated bundled adapters, pinned verifier recipes and independent verification quorums, encrypted backups, replayable history compaction, public proof-of-work admission, and an optional contribution-credit ledger.

The implementation supports trusted teams, invited contributors, and open contributors with resource-priced admission. Task acceptance remains governed by the project verifier policy. Optional credits use proof-of-work fork choice and confirmation depth; they are experimental project units without monetary value or a redemption promise.

## Live Codex result

The live evaluation used the existing authenticated Codex CLI to investigate the installed GNU `basename`, generate an implementation, admit follow-up work and independently verify its behavior. Both the multi-stage run and single-agent baseline passed 140 final checks (116 distinct invocations beyond the regular verifier) over arbitrary path strings and supported CLI options. The generated programs use general algorithms, not the lookup-table approach of the earlier fixture.

The single-agent baseline took about 73 seconds; the two-stage run took about 212 seconds, including one failed planning attempt and retry. Completed-result token reports were 89,159 versus 209,184; conservative budget charges also include the failed attempt's reservation. This one small sequential workload shows coordination overhead, not a general swarm speedup. Exact stderr wording, help/version text, and filesystem inputs were outside its declared contract.

See [the measured comparison](artifacts/live/comparison.json), [swarm result and source location](artifacts/live/report.json), and [baseline result](artifacts/live-baseline/report.json). Signed proof archives contain public events and hashed objects, not authentication credentials.

```sh
# Requires the installed Codex CLI to already be authenticated.
bun run benchmark:live
bun run benchmark:baseline

# Or use the native Codex adapter in your own project.
bun run swarm work --state .swarm/worker --watch \
  --capability static-analysis -- bun examples/codex-adapter.ts
```

The adapter runs `codex exec` ephemerally with a read-only tool sandbox and structured output. Authentication stays in Codex's normal local account store. User configuration/plugins are ignored for these bounded jobs; `BITSWARM_CODEX_MODEL` can select a model. For tasks without a contract, the adapter checks reported usage against `BITSWARM_CODEX_DEFAULT_MAX_TOKENS` (default 64,000, including model input). Tasks with a contract use its declared token limit. The broker is an operator-trusted local program with access to the account, while generated programs are checked by an isolated verifier. Tokens are reported by Codex after execution; no dollar price or hard provider-side billing limit is inferred.

## Experimental Codex accounts

On a POSIX worker, give each Codex sign-in a local label. Run this in the terminal on the machine that will do the work. Choose the intended ChatGPT account in the browser on each iteration.

```sh
for account in alpha bravo charlie; do
  bun run codex:accounts login --experimental --account "$account" || break
  bun run codex:accounts status --experimental --account "$account" || break
done
```

For a headless worker, add `--device-auth` to the login command if your account permits device sign-in. Codex handles authentication and token refresh. Each label has its own owner-only directory beneath `~/.local/share/bitswarm/codex-accounts/`. Codex stores its credentials there in a **plaintext** `auth.json`. To select another private location, set `BITSWARM_CODEX_ACCOUNTS_DIR` to an absolute path outside your project. BitSwarm checks file ownership and permissions and leaves credential contents to Codex. [Codex authentication and storage](https://developers.openai.com/codex/auth#credential-storage)

To put all three accounts to work, run the command below in three terminals, setting `account` to a different label in each. Point them at the same joined state directory and choose capabilities matching your blocks.

```sh
account=alpha
bun run swarm work --state .swarm/worker --watch --capability static-analysis \
  -- bun examples/codex-adapter.ts --experimental --account "$account"
```

Each process stays on its assigned account. All three share the node's signing identity, task queue, and project budget. Up to three eligible blocks can run concurrently if the project's concurrency limit allows it. Interrupted, rate-limited, or expired sessions follow the normal attempt-failure policy. The operator can check the affected label with `codex:accounts status` and sign in again. Profile names are local configuration and are omitted from the signed receipts. Named jobs disable shell access and receive bounded excerpts of assigned files. The original single-account command above continues to use the default Codex sign-in.

## Claude Code adapter

Use the installed Claude Code CLI with a locally configured Anthropic API key or a supported Claude Code sign-in. The worker's default process isolation lets the CLI contact the provider.

```sh
bun run swarm work --state .swarm/worker --watch --capability static-analysis \
  -- bun examples/claude-adapter.ts
```

The adapter requests structured JSON in print mode with session persistence and task tools disabled. Each input excerpt contains up to 16 KiB, with a 64 KiB total for evidence. Excerpts identify their source and mark truncation. The model can request an optional input offered by the block. This mode fits tasks that can be answered from the assigned evidence.

Set `BITSWARM_CLAUDE_MODEL` to choose a model and `BITSWARM_CLAUDE_CONFIG_DIR` to select the CLI configuration directory. Claude blocks with a contract need positive `maxTokens` and `maxCostMicros`. Without a contract, the defaults are 64,000 tokens and an estimated US$1 per invocation, configurable with `BITSWARM_CLAUDE_DEFAULT_MAX_TOKENS` and `BITSWARM_CLAUDE_DEFAULT_MAX_COST_MICROS`. The receipt records reported tokens, including cache usage, and Claude's estimated cost in microdollars. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

## Run it

Requires Bun 1.4.2 or newer. The live utility evaluator also uses Node 22.18+; Linux Bubblewrap is the default verifier boundary. Docker is an alternative with a locally prepared runtime image. The reconstruction benchmark also needs `cc` and a Linux-compatible executable environment.

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run demo
bun run benchmark
bun examples/replay.ts artifacts/benchmark/swarm-proof.json
# Optional on hosts with Bubblewrap, Docker and multicast support:
bun run test:integration
```

`demo` runs three HTTP peers through the six-block reverse-engineering workflow with a fixture adapter and two independent reviewers. `benchmark` compiles a small C application, distributes black-box observations to three worker processes, admits an integration task dynamically, generates an executable TypeScript reconstruction, and independently checks it against the native application. It also runs a single-worker baseline. Reports and complete reconstructed sources are written under `artifacts/benchmark/`; `comparison.json` records the latest generated source paths.

The benchmark exhaustively covers 192 valid inputs in its declared finite domain plus 13 boundary/error cases, with 397 checks across subsystem and integrated verification. It uses deterministic observation, not an LLM, and reports zero model usage. It does not establish LLM quality or general speedup on real applications. The generic HTTP provider path has a local fixture test; the Codex path also has the live result described above.

## Project owner: initialize and share

```sh
export BITSWARM_TOKEN='<random secret of at least 32 characters>'
bun run swarm init --state .swarm/owner \
  --manifest examples/reverse-engineering.json --input ./application.bin
bun run swarm peer --state .swarm/owner --port 7331
```

In another terminal with the same token:

```sh
bun run swarm share --state .swarm/owner --peer http://127.0.0.1:7331
```

This prints a magnet-style invitation:

```text
swarm://<manifest-sha256>?v=1&dn=Application+reconstruction&peer=<encoded-origin>
```

The hash pins the genesis manifest, including original inputs, blocks, planner and reviewer keys. Peer locations are replaceable hints. Access secrets are not put in links. Use an address reachable by your contributors; the embedded HTTP server defaults to loopback. Put HTTP behind your own HTTPS endpoint for connections between hosts, or use the encrypted libp2p transport below.

```sh
bun run swarm join --state .swarm/worker '<printed swarm:// URI>'
bun run swarm peer --state .swarm/worker --port 7332 --peer http://127.0.0.1:7331
```

Peer and worker processes can share a local state directory. Different agents should use different directories and identities. SQLite transactions preserve local work and enforce concurrent reservations across processes.

## Connect an LLM

The included adapter accepts an OpenAI-compatible chat-completions endpoint. It runs a bounded tool loop with workspace file reading, directory listing, and explicitly approved local tools. Source bytes are materialized into files rather than pasted wholesale into the model context.

```sh
export BITSWARM_LLM_ENDPOINT='https://your-provider.example/v1/chat/completions'
export BITSWARM_LLM_MODEL='<model identifier>'
export BITSWARM_LLM_API_KEY='<provider credential>'
# Supply provider prices as micro-currency-units per million tokens for cost accounting.
export BITSWARM_LLM_INPUT_MICROS_PER_MILLION='0'
export BITSWARM_LLM_OUTPUT_MICROS_PER_MILLION='0'

bun run swarm work --state .swarm/worker --watch \
  --capability static-analysis --capability synthesis --capability test-design \
  -- bun examples/llm-adapter.ts
```

A zero configured price means cost is unpriced; it does not mean the provider is free. Provider usage reporting is required. The model runs with a turn limit, token accounting and a task deadline. Provider-side billing can happen before usage is reported, so these checks are not a hard billing guarantee. Set independent spending controls with your provider.

Tools are disabled until configured by the operator. For example, a local JSON file may contain `{"disassemble":["/usr/bin/objdump","-d"]}`. Point `BITSWARM_LLM_TOOLS` at its absolute path. The model may choose arguments for these tools. The bundled LLM adapter defaults tool execution to `bwrap`, with no network or home-directory mounts. Set `BITSWARM_LLM_TOOL_ISOLATION=docker` and `BITSWARM_LLM_TOOL_IMAGE=<prepared image>` to use Docker instead. `process` is available for operator-trusted tools, with ordinary process privileges. Isolation failures do not fall back to unrestricted execution.

The model broker runs outside tool isolation so it can contact the provider. The HTTP adapter's approved tool subprocesses do not inherit provider credentials or the swarm secret; native Codex uses its own trusted broker and sandbox boundaries. Worker `--isolation bwrap|docker` separately isolates an entire adapter, bundling local JavaScript/TypeScript code into its job workspace; an adapter that needs external networking cannot use the supplied network-disabled profiles without a different operator-managed arrangement.

You can substitute any local JSON adapter:

```sh
bun run swarm work --state .swarm/worker --watch \
  --capability static-analysis -- /absolute/path/to/my-adapter
```

Adapters read one `bitswarm.adapter.v1` JSON packet from stdin and return `{summary, artifact, usage:{tokens,costMicros}}` on stdout. Logs belong on stderr. Packets contain instructions, deadlines, dependency receipts, hashes, available source objects, and materialized source paths. See [examples/adapter.ts](examples/adapter.ts) for the fixture contract, and [examples/llm-adapter.ts](examples/llm-adapter.ts) for provider integration.

## Contracts and verification

A block can declare a contract:

```json
{
  "timeoutMs": 300000,
  "maxAttempts": 3,
  "maxTokens": 16000,
  "maxCostMicros": 1000000,
  "schema": {
    "type": "object",
    "properties": { "findings": { "type": "array" } },
    "required": ["findings"]
  },
  "verifier": "application-parity"
}
```

JSON Schema is checked locally and again in the replicated state projection. In protocol 3 a named verifier requires independent passing attestations from the configured verification quorum (the project quorum by default), in addition to review quorum. `verifierHash` optionally pins the bundled recipe including imported helpers, and `verificationQuorum` can set an explicit threshold. The executable implementing that name is chosen locally by the reviewer; peers cannot remotely supply executable commands.

```sh
bun run swarm status --state .swarm/owner
bun run swarm inspect --state .swarm/owner --result '<result ID>'
bun run swarm verify --state .swarm/owner --result '<result ID>' \
  -- /absolute/path/to/verifier
bun run swarm review --state .swarm/owner --result '<result ID>' \
  --verdict approve --reason 'Reproduced the evidence and parity checks'
bun run swarm checkpoint --state .swarm/owner
bun run swarm export --state .swarm/owner --output findings.json
```

The verifier reads a JSON packet with the task, result, artifact and materialized source paths, then returns `{passed:boolean, checks:[{name,passed}]}`. Reports are hashed, signed and replicated. The reconstruction benchmark includes a real executable parity verifier in [examples/reconstruction/verifier.ts](examples/reconstruction/verifier.ts).

Self-review does not count. Review quorum must be a strict majority of pinned reviewers. For multiple reviewers, run `keygen` in each reviewer's state directory and place the resulting public keys in the manifest before initialization. Empty template reviewer lists resolve to the initializing owner's key.

## Planning, retries and recovery

The planner defaults to the first genesis reviewer unless explicitly set in the manifest. Changes are signed records in an authority chain; the genesis swarm identity remains stable.

```sh
bun run swarm propose --state .swarm/worker --file new-block.json --reason 'Discovered subsystem'
bun run swarm sync --state .swarm/worker --peer http://127.0.0.1:7331
bun run swarm admit --state .swarm/owner --proposal '<proposal ID>'
bun run swarm cancel --state .swarm/owner --block '<block ID>'
bun run swarm retry --state .swarm/owner --block '<block ID>'
bun run swarm retry --state .swarm/owner --result '<result ID>'
bun run swarm policy --state .swarm/owner --file policy.json
bun run swarm delegate --state .swarm/owner --publicKey '<new planner key>'
```

Workers renew live claims during execution, bounded by the task timeout. Cancellation, revocation, invalidated dependencies and an authority fork stop the running adapter; publication checks the latest state again inside a transaction. Process-group and tracked descendant cleanup also cover nested trusted adapters. Crashes leave leases that expire. Reported adapter failures release work immediately and conservatively charge the attempt's reserved budget. `maxAttempts` stops repeated failures; planner `retry --block` resets the attempt window and resumes cancelled blocks. Pending reviews time out according to `reviewTimeoutMs`. Approved results do not expire just because their original review window has elapsed.

Distinct quorum-approved artifacts dispute a block and stop its descendants. `resolve --block ID --result HASH` lets the planner choose an already approved candidate. `checkpoint` freezes the selected results' review evidence against subsequent contradictory reviews. Metadata and referenced artifacts are still required to replay the project. Checkpoints are project-authorized snapshots, not irreversible Byzantine finality.

If the planner signs conflicting control branches, new work stops. Pinned reviewers can independently issue `reconcile --parent HASH --selected CONTROL_HASH`; a quorum restores the selected branch. If the planner's key is lost, reviewers can issue `recover --parent HEAD_HASH --publicKey NEW_KEY`; a quorum authorizes a replacement without the old private key. Reviewers must agree on the current head and keep their own identities available for recovery.

## Individual invitations and revocation

Set `"policy":{"admission":"invite"}` in a new project manifest, or change policy through its planner. Signed request authentication then replaces the shared bearer token.

```sh
# Contributor: send only the printed public key to the owner.
bun run swarm keygen --state .swarm/contributor

# Owner:
bun run swarm invite --state .swarm/owner --publicKey '<contributor key>' \
  --role worker --expires 86400 --output contributor-invitation.json

# Contributor, using the original keygen directory:
bun run swarm join --state .swarm/contributor --invite contributor-invitation.json '<swarm URI>'

# Owner:
bun run swarm revoke --state .swarm/owner --publicKey '<contributor key>'
```

Roles are worker, reader, and reviewer. Reviewer access alone does not add a new voting key to the genesis committee. Invitations are bound to a contributor key, swarm, issuing authority and expiry. Every signed request binds the method, path, body hash, time and nonce. Nodes reject replay and locally known revocations. Previously issued invitations survive an ordinary planner transfer through their authority-chain proof. Revocations take effect as the control chain replicates; an isolated node cannot know a revocation it has not received.

Policies support `maxConcurrent`, `maxTokens`, `maxCostMicros`, `reviewTimeoutMs`, `eventQuota`, `storageBytes`, `uploadBytes` and `requestsPerMinute`. Invite budgets can be allocated using `--tokens`, `--costMicros` and `--concurrency`. Finite project spending caps require task contracts and explicit contributor allocations; unallocated contributors receive no spending allowance. Recorded contributor allocations cannot exceed project caps or silently be reclaimed on revocation. All budgeted workers, including the planner when doing work, need explicit allocations. New allocations and claims conserve existing allocations, reported spending and unknown/expired attempt reservations. Revocation and compaction do not release unreported expenditure. Budgets are enforced by honest local workers against their signed usage and reservations; arbitrary external commands and dishonest usage declarations are not a remote billing system.

## Encrypted mesh, discovery and relays

```sh
# Reachable seed/router. --relay also offers bounded circuit-relay service.
bun run swarm mesh --state .swarm/owner \
  --listen /ip4/0.0.0.0/tcp/7333 --dht --relay --lan

# Use a printed reachable address in a share link or bootstrap another mesh node.
bun run swarm share --state .swarm/owner --peer 'libp2p:/ip4/HOST/tcp/7333/p2p/PEER_ID'
bun run swarm mesh --state .swarm/worker --bootstrap '/ip4/HOST/tcp/7333/p2p/PEER_ID' --lan
```

Libp2p handles TCP, Noise encryption, multiplexing, mDNS, project-scoped Kademlia provider discovery, circuit-relay transport/server and DCUtR hole-punching support. Under Bun, Noise uses the library's supplied pure-JavaScript crypto implementation for compatibility with larger encrypted frames.

A seedless `swarm://HASH?v=1` can be joined with `--bootstrap MULTIADDR` to discover providers, or `--lan` to look locally. A DHT still needs initial routing connectivity; the repository does not deploy a worldwide bootstrap service. `peer --discover` optionally learns more HTTP/libp2p hints from already configured peers.

To listen through an existing relay, give `mesh --listen '/ip4/RELAY/tcp/PORT/p2p/RELAY_ID/p2p-circuit'`. Share its resulting relayed address. Direct and circuit-relayed transfers and provider discovery are tested locally. DCUtR is configured, but success across actual ISP NAT/firewall combinations has not been established by these local tests.

Linux desktop integration is available through `install-handler --register`. Use `--output DIR` without registration to inspect a generated `.desktop` file first. The `open URI` entry point selects a project-specific directory under `BITSWARM_STATE_ROOT` or `~/.local/share/bitswarm`. Credentials remain out of band. No desktop settings are modified during the ordinary tests or demo.

## Storage and operations

Imports use bounded-memory, two-pass streaming, 256 KiB chunks, and a hashed index with the full-file SHA-256. The CLI accepts regular files up to 2 GiB; storage quotas still apply. Default object storage is 128 MiB per node, configurable through policy. Each uploader is limited to 32 MiB by default; set `uploadBytes` as well as `storageBytes` for larger transfers. A node holds at most 10,000 objects, 10,000 events, 1,000 blocks, and 1 MiB per object. Results must fit in one object; larger output formats need an application-level chunk index.

```sh
bun run swarm sync --state .swarm/worker --peer https://seed.example --only '<block ID>'
bun run swarm sync --state .swarm/observer --peer https://seed.example --metadataOnly
bun run swarm put --state .swarm/owner --file ./application.bin
bun run swarm restore --state .swarm/owner --hash '<file index hash>' --output ./restored.bin
bun run swarm metrics --state .swarm/owner
bun run swarm scoreboard --state .swarm/owner
bun run swarm gc --state .swarm/owner
```

Selective replication persists the chosen blocks, includes prerequisites, and requests only needed objects. Completed chunks survive restart, so retries resume at object granularity. Metadata inventories are paginated. Nodes retain configured/discovered peers with backoff, quarantine repeatedly invalid objects, and continue transferring valid objects. `put` pins a file index; `pin`/`unpin` manage additional roots. Garbage collection removes unreferenced blobs while preserving manifest, result, verification and pinned file objects. Use protocol 3 compaction for archived terminal attempts; governance and essential proof records remain.

`metrics` reports block states, own usage/reservations, transfers, peers and quarantine. `scoreboard` counts accepted contributions; it is not currency or a payout promise. Network limits include request/body bounds, contributor event and upload quotas, rate limits, and replay protection. These bound common mistakes and some abuse; they do not make public anonymous admission Sybil-resistant.

## Unattended operation and recovery

`run --config FILE` drives peer synchronization, local workers, guarded admission of agent-proposed tasks, independent executable verification, automatic review and checkpointing. Planner policy restricts block count, capabilities, verifier names and available inputs. Auto-approval requires an explicitly configured executable verifier; schema validity alone does not trigger approval. Worker adapters may return up to eight `{block,reason}` entries in `proposals`. `goalBlocks` prevents an initial planning task from being mistaken for the completed project.

```json
{
  "listen": { "port": 7331 },
  "peers": [],
  "planner": {
    "maxBlocks": 100,
    "capabilities": ["coding"],
    "verifiers": ["parity"],
    "checkpoint": true
  },
  "reviewer": {
    "verifiers": { "parity": ["bun", "/absolute/path/to/verifier.ts"] },
    "autoApprove": true
  },
  "pollMs": 500,
  "deadlineMs": 3600000,
  "goalBlocks": ["integration"],
  "stopWhenComplete": true
}
```

Run worker actors in separate identity directories with a `worker` configuration containing `command`, `capabilities` and optional `ttlMs`, `isolation` and `image`. The owner should use a different key from workers. Shutdown drains active synchronization and cancels owned work. State and automation decisions persist in SQLite.

```sh
bun run swarm run --state .swarm/owner --config owner.json

# Supply this through your local secret manager; do not put it in a share link.
export BITSWARM_BACKUP_PASSPHRASE='<long private passphrase>'
bun run swarm backup --state .swarm/owner --output project.backup
bun run swarm restore-state --state .swarm/restored --file project.backup
bun run swarm compact --state .swarm/owner
```

Backups use scrypt and authenticated AES-256-GCM, include the node's identity and access material, and restore through a verified staging directory before atomic publication. Existing directories are never overwritten. Compaction requires protocol 3, archives terminal attempts as hashed compressed chunks and emits signed accounting summaries. It preserves selected checkpoint evidence, costs and attempt windows, ignores resurrected archived records, and removes physical rows once an archive is available. Planner-signed compaction summaries are trusted project records, not an independent proof that an operator reported costs honestly. Governance and required proof records remain, so finite project/event limits still apply. Legacy protocol 1/2 projects can be backed up and read; create protocol 3 projects for the new record types. Future database schema versions are rejected.

## Public contributors and optional credits

A protocol 3 manifest can set `"policy":{"admission":"public","publicWorkBits":12}`. New peers can join a public `swarm://` link without a shared secret. Requests are signed, bound to the swarm, timestamped, nonce-protected, and resource-priced with a bounded proof-of-work calculation. Public admission does not make identities independent or remove the project's verifier policy. Ordinary reader/worker revocation and quotas still apply. Finite shared spending caps require allocated actors; public contributors may instead bring their own provider budgets.

To opt into non-monetary contribution credits, add immutable genesis settings such as `"credits":{"difficulty":12,"reward":10,"confirmations":6}`. Checkpointed accepted contributions can receive one reward on a valid ledger branch. Transfers consume owned outputs, conserve units and may pay a fee to a miner. Miners use proof of work; the highest-work chain wins, with deterministic tie breaking. Confirmation depth delays spendability but cannot guarantee irreversible finality. Result eligibility still depends on project checkpoints, and a governance reorganization can affect eligible rewards.

```sh
bun run swarm credits --state .swarm/worker
bun run swarm mine --state .swarm/worker --result '<checkpointed result ID>'
bun run swarm mine --state .swarm/worker
bun run swarm transfer --state .swarm/worker --to '<public key>' --amount 3 --fee 1
# Pass transfer IDs to mine through --file transfers.json.
```

There is no fiat payment, exchange integration, staking market or audited cryptocurrency claim. Public mode and credits are opt-in; the default remains a project-controlled team swarm.

The bounded fault/load rehearsal completed 180 tasks, injected 54 offline rounds and restarted the seed HTTP server 27 times, then converged all four replicas. It removed 60 terminal history records while preserving accounting. See [stress evidence](artifacts/validation-v3/stress.json). Run `bun run stress` to repeat it; its traffic phase defaults to 60 seconds and final healing/compaction can take longer.

See [protocol details](docs/protocol.md), [URI specification](docs/swarm-uri.md), and [current validation evidence and remaining coverage](docs/validation-v3.md).
