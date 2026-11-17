# Validation journal and coverage

Candidate: BitSwarm 0.2 in this repository, tested on Linux with Bun 1.4.2. The compiled reconstruction fixture uses the local C compiler. Local Bubblewrap and Docker isolation integrations were enabled and exercised separately from ordinary CI requirements.

This report distinguishes execution of the public CLI from tests calling protocol functions. It does not claim exhaustive coverage of every input, network topology, external provider or adversary.

## Recorded checks

| Check                                                 | Evidence                                                                                                          | Outcome                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| TypeScript validation                                 | [typecheck.log](../artifacts/validation/typecheck.log)                                                            | Passed                                                                              |
| Formatting                                            | [format.log](../artifacts/validation/format.log)                                                                  | Passed                                                                              |
| Full suite with isolation and LAN integration enabled | [tests.log](../artifacts/validation/tests.log)                                                                    | 44 passed, no skipped tests in this environment                                     |
| Explicit Bubblewrap/Docker integrations               | [isolation.log](../artifacts/validation/isolation.log)                                                            | Both passed; no external network or home-directory exposure in the checked profiles |
| Original three-peer workflow                          | [demo.log](../artifacts/validation/demo.log)                                                                      | Six blocks accepted; 24 signed records and eight objects converged                  |
| Compiled application reconstruction                   | [benchmark.log](../artifacts/validation/benchmark.log), [comparison.json](../artifacts/benchmark/comparison.json) | Both single-worker and three-worker runs passed 397 checks each                     |
| Offline proof replay                                  | [replay.log](../artifacts/validation/replay.log), [swarm-proof.json](../artifacts/benchmark/swarm-proof.json)     | Revalidated hashes and signatures; four blocks accepted; 397 passing checks         |

The benchmark uses deterministic executable observation, with no model calls. It exhaustively checks 192 valid cases in the declared finite domain, samples 13 invalid/boundary cases at integration, and repeats the valid cases during independent subsystem verification. Its measured time includes verification and integration. A small observed runtime difference is not evidence of a general swarm speedup. Complete generated source locations are recorded in `comparison.json`.

## User journeys

| Persona / area             | Entry point and goal                                                                      | Evidence                                          | Coverage                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| New project owner          | `init`, `share`, `status`                                                                 | `tests/cli.test.ts`, `tests/journeys.test.ts`     | Passed through CLI subprocesses                                                       |
| Contributor                | `keygen`, `join --invite`, `sync`, `claim`, `renew`, `submit`                             | `tests/journeys.test.ts`                          | Passed through CLI subprocesses                                                       |
| Automatic worker           | `work` with adapter execution, result publication and dependency unlock                   | `tests/cli.test.ts`, reconstruction benchmark     | Passed through CLI plus real subprocess/network integration                           |
| Reviewer                   | `inspect`, `review`, `checkpoint`, `export`                                               | CLI/journey tests and benchmark                   | CLI review flow passed; executable `verify` implementation exercised by the benchmark |
| Planner                    | `propose`, `admit`, `cancel`, `retry --block`, `policy`                                   | `tests/journeys.test.ts`                          | Passed through CLI subprocesses                                                       |
| Planner failure recovery   | Fork reconciliation, authority transfer and lost-key recovery                             | `tests/lifecycle.test.ts`                         | Core protocol passed; every CLI argument variant not separately exercised             |
| Contributor administrator  | `invite`, reader access, replay rejection, `revoke`                                       | Journey and access tests                          | CLI invitation/revocation and real HTTP role boundaries passed                        |
| Storage operator           | `put`, `restore`, `pin`, `unpin`, `gc`, persistent reopen                                 | Journey, artifact and network tests               | CLI flow and streaming/hash checks passed                                             |
| Selective replica          | Block selection and unrelated-object exclusion                                            | `tests/access.test.ts`                            | Real HTTP transfer passed; every selection/graph shape not sampled                    |
| Mesh participant           | Copy a `swarm://` link and join without HTTP                                              | `tests/journeys.test.ts`                          | Passed through CLI subprocess and encrypted RPC                                       |
| Relay participant          | Fetch objects using a circuit-relayed address                                             | `tests/mesh.test.ts`                              | Passed using three actual local libp2p nodes                                          |
| Seedless discovery         | Find a manifest provider through a DHT router                                             | `tests/mesh.test.ts`                              | Passed using actual local DHT provider announcements and queries                      |
| LAN participant            | Discover a seedless project through multicast                                             | `tests/mesh.test.ts`                              | Passed with two real local mDNS participants; cross-host deployment untested          |
| Operator                   | `metrics`, `scoreboard`, generated desktop handler                                        | `tests/journeys.test.ts`, `tests/runtime.test.ts` | CLI/local generation passed; desktop registration intentionally not applied           |
| Model integration consumer | Tool call, workspace evidence, provider usage and budget overflow                         | `tests/agent.test.ts`                             | Passed against a local HTTP provider fixture; no paid provider called                 |
| Isolated tool operator     | Workspace mounts, no home exposure, no external routing                                   | `tests/isolation.test.ts`                         | Passed with Bubblewrap and Docker on this host                                        |
| Failure recovery           | Invalid adapter, expired claim, invalid remote objects, original-seed loss, SQLite reopen | Network/lifecycle/runtime tests                   | Passed within the tested local topologies                                             |

## Findings retained from testing

**J-001: larger encrypted mesh responses failed under Bun.** A real CLI join through a copied libp2p link failed with `Incomplete mesh frame`; server-side quarantine recorded `Unknown cipher`. Small in-process transfers had passed. The dependency's default crypto implementation switched to a Node cipher path for larger frames that was unavailable in this runtime. The fix selects the upstream library's supported pure-JavaScript Noise crypto implementation. The same CLI join and a 256 KiB encrypted transfer now pass. The regression lives in the mesh and journey tests.

**J-002: reconstructed command dispatch accepted prototype-property names.** The initial reconstruction used inherited object-property lookup to recognize command names. Additional parity cases for `__proto__`, `constructor` and `toString` found behavior mismatches against the original executable. [The failing check report](../artifacts/benchmark/failed-assemble.json) is retained. Dispatch now uses an own-property check. All 13 boundary cases pass on the resulting reconstruction. These are actual generated-application checks, not source-only assertions.

**J-003: retry windows based solely on millisecond time could miscount new attempts.** Work created immediately after a resume could share its timestamp with the reset. Claims now bind an authority epoch, and attempt windows use the replicated control order. An exhausted/resumed/exhausted regression passes. Version 2 claims require the authority epoch.

The temporary test state directories, generated native targets and test containers are removed by their owning runs. Persistent artifacts under `artifacts/benchmark` and logs under `artifacts/validation` remain for review. Private keys and provider credentials are not included in the proof archives.

## Explicit gaps

- Live provider authentication, quality, spend and real-model agent performance require an operator-configured endpoint and credentials. The provider adapter contract and tool behavior were exercised with a local fixture, not represented as a live paid evaluation.
- Circuit relay and DHT discovery passed locally. DCUtR is wired through libp2p, but actual hole punching across external NAT/firewall/ISP combinations is not established by these tests. Local multicast discovery also passed; cross-host mDNS interoperability is not certified by that single-host check.
- Desktop entry generation passed. Actual GUI/browser association and click-to-join behavior in a user's desktop session were not applied or tested.
- The generated finite-domain application passes its specified parity suite. Arbitrary binary formats, large application reconstruction and semantic equivalence outside that domain remain unproven.
- No public internet load test, Byzantine-liveness proof, anonymous Sybil resistance, permissionless economic consensus, financial payout system or irreversible finality is claimed.
- Runtime isolation has the checked mounts/network restrictions. Docker image packaging and locally approved tool capabilities remain operator choices; this suite is not a general sandbox-escape audit.
