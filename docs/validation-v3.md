# BitSwarm 0.3 validation

This release addresses the three reproduced defects and adds a real Codex evaluation, autonomous lifecycle execution, stronger verifier policy, operational recovery and optional public/credit protocols. Earlier evidence remains in [validation.md](validation.md); this file describes the new candidate.

## Real inference and reconstruction

The evaluation used the existing authenticated Codex CLI. No API credential was extracted or copied into project packets, archives or peers. Jobs used ephemeral CLI sessions, read-only tool execution and a structured final schema. Target artifacts were from the installed GNU basename utility, not source code supplied to the model. The captured live projects use the supported protocol 2 profile; protocol 3-specific public admission, credit, quorum and compaction behavior has separate API/CLI tests.

The declared contract covers arbitrary path strings and CLI processing for single operands, optional suffixes, multiple operands, -a/--multiple, -s/--suffix, -z/--zero, combined options and the -- separator. The generated implementation uses algorithms rather than tables. Exact stderr wording, help/version text, external input files and semantic equivalence on every possible input were outside this evaluation.

| Run                                          | Elapsed    | Independent holdout | Completed-result token reports | Budget charges including failed attempts |
| -------------------------------------------- | ---------- | ------------------- | ------------------------------ | ---------------------------------------- |
| Investigation agent followed by coding agent | 212,285 ms | 140 / 140 passed    | 209,184                        | 509,184                                  |
| Single-agent baseline                        | 73,078 ms  | 140 / 140 passed    | 89,159                         | 89,159                                   |

The multi-stage run had two investigation attempts, one resulting in an accepted specification, and one coding attempt. Failed attempts consume their reserved budget; these charges are not actual billed-token or dollar figures. The account was unpriced. One sample per mode is insufficient for general performance conclusions. On this small sequential task the single agent was faster and used fewer recorded tokens.

Evidence:

- [Measured comparison](../artifacts/live/comparison.json)
- [Swarm report and generated source location](../artifacts/live/report.json), [signed archive](../artifacts/live/proof.json), [holdout details](../artifacts/live/holdout.json)
- [Single-agent report](../artifacts/live-baseline/report.json), [signed archive](../artifacts/live-baseline/proof.json)
- [Offline replay of swarm proof](../artifacts/validation-v3/live-replay.log), [baseline replay](../artifacts/validation-v3/baseline-replay.log)

A preliminary local-model run failed and was not represented as a successful reconstruction. Initial Codex candidates also exposed an evaluation-runner defect: Bun consumed the first -- separator. The reference utility received it while the candidate did not. That runner was replaced with Node's argument-preserving TypeScript execution, and the actual Codex experiment was rerun without manually patching generated application source. Initial evidence remains under `artifacts/live-codex-initial`.

## Confirmed repairs

| Defect                                                                         | Repair                                                                                                                           | Regression evidence                                                                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A 100-token project could spend 60 then allocate another 60                    | Conservation includes allocations, legacy expenditure and pending/unknown attempt reserves; all budgeted actors need allocations | `tests/repairs.test.ts` reproduces spending/reservation cases and rejects the overcommit |
| Cancelled adapters continued and published results                             | Live cancellation/revocation/invalidated dependencies interrupt execution; publication rechecks state transactionally            | Running-job cancellation and detached-descendant regressions in `tests/repairs.test.ts`  |
| Docker received the host's Bun executable path                                 | Container commands resolve inside the image; job paths are remapped and JavaScript/TypeScript adapters are bundled               | Direct Bun and complete worker execution through Docker pass                             |
| Whole-adapter isolation could mount the project directory                      | Adapter execution now runs in a dedicated job workspace; isolated code is bundled there                                          | Full Bubblewrap worker test verifies relocated /work and absent account home             |
| Automated shutdown left synchronization promises running                       | Synchronization is tracked and drained before database close                                                                     | Full unattended multi-actor test completes without post-close database errors            |
| A single verifier could satisfy a larger committee's machine-check requirement | Protocol 3 uses explicit verification quorum, defaulting to project quorum, and optional recipe pins                             | Wrong-recipe and independent-quorum regressions in `tests/verification.test.ts`          |
| CLI argument and work-proof inputs could be mishandled                         | Public-link CLI journey, audience binding, difficulty validation and time bounds are tested                                      | Public admission, cross-swarm replay rejection and CLI recovery tests                    |

The recipe hash includes bundled imported helper code. It does not attest every external runtime dependency. Verifier reports remain signed claims by trusted project keys; independently executing checks improves evidence but is not a universal proof that an LLM's conclusions are true.

## Fault/load and recovery evidence

The single-host rehearsal used four real stores with HTTP replication, a configured trusted-load request quota, and a 60-second traffic phase followed by draining, checkpointing and compaction. Total run duration was 93,948 ms.

- 180 tasks completed and accepted.
- 54 offline rounds and 27 seed HTTP-server restarts.
- All replica inventories converged after healing.
- Compaction removed 60 terminal records; active history changed from 780 to 750 records after adding signed accounting controls.
- Peak observed process RSS was 115,597,312 bytes; slowest measured traffic round was 1,474 ms. These are observations from this host, not service-level guarantees.

[Stress report](../artifacts/validation-v3/stress.json) contains the raw metrics and accounting summary. The default request quota was correctly hit in an earlier load run; quota responses now use 429 and Retry-After, and the controlled capacity rehearsal explicitly configures a higher quota.

Additional tests kill a writer process with SIGKILL after a committed SQLite WAL write, heal partitioned duplicate work into a dispute, mutate 1,000 signed envelopes, verify encrypted backup/restore with tamper rejection, reject future database versions, and preserve accounting across compaction and restoration. Archived records cannot be resurrected by ordinary ingestion.

## Evidence files

The final full-suite log is [tests.log](../artifacts/validation-v3/tests.log). Type checks, formatting and fixture runs are retained beside it. The suite includes conditional integration tests for actual Docker, Bubblewrap and local multicast; the final local run enables all three. The logged result is the authoritative count.

| Surface                       | How exercised                                       | Scope                                                                                         |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Project owner and contributor | Public CLI subprocess journeys                      | Initialize, invite/share/join, work, review, checkpoint and export                            |
| Unattended team               | Real HTTP and adapter/verifier subprocesses         | Proposals, guarded admission, work, checks, review and checkpoints without manual transitions |
| Codex                         | Native authenticated CLI against real model service | Investigation, code generation and measured single-agent comparison                           |
| Credential handling           | Native account auth and artifact inspection         | No exported credentials; trusted Codex broker retains normal local account access             |
| Execution isolation           | Bubblewrap and Docker integration profiles          | Job-only mount, executable mapping, cancellation and process cleanup                          |
| Recovery                      | CLI/API, encrypted archive and abrupt writer death  | Keys, source objects, signed records, schema handling, accounting and WAL persistence         |
| Public participation          | Signed work-priced HTTP and CLI joining             | Quotas, proof bounds, nonce rejection and swarm audience binding                              |
| Contribution credits          | Actual work validation and ledger projection        | Checkpoint rewards, confirmed spends, double-spend rejection and higher-work reorganization   |
| P2P connectivity              | Real local libp2p peers                             | Encrypted direct and relayed transfer, DHT provider lookup and multicast discovery            |

## Boundaries that remain external validation work

This candidate is not a claim of arbitrary application reconstruction, public-internet Byzantine liveness, economic security, audited financial value or irreversible finality. Task acceptance is project-policy governed. Credit confirmations are probabilistic, and checkpoint governance can affect reward eligibility. Public work pricing raises admission cost without proving independent identities.

WAN NAT/firewall diversity and browser desktop association were not exercised on this single host. Docker image preparation and source ABI/runtime compatibility are operator choices. Bubblewrap provides the documented mount/network boundary, while Docker additionally applies the configured CPU/memory/PID limits; this is not a sandbox-escape audit. Provider-side spending can occur before usage is reported, and cloned identities or dishonest usage declarations are outside honest local budget enforcement. Use provider-side controls for monetary limits.

The current workflow tests one installed CLI utility under a declared behavior contract. Larger native applications, browsers, mobile apps, GUI interaction and long-lived production deployments need their own target-specific tools, verifier suites and operational evaluation. Those are validation domains, not evidence supplied by the small utility or fixture benchmarks.
