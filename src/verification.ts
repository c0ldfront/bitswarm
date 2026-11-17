import { hydrateTask } from "./network.ts";
import { prepareVerifier } from "./recipe.ts";
import {
  assert,
  canonical,
  makeEvent,
  validVerificationChecks,
} from "./core.ts";
import { execute, workspace, type Isolation } from "./runtime.ts";
import type { Store } from "./store.ts";
export async function verifyResult(
  store: Store,
  id: string,
  command: string[],
  isolation: Isolation = "bwrap",
  image?: string,
  signal?: AbortSignal,
  peers?: string[],
) {
  signal?.throwIfAborted();
  const result = store.event(id);
  assert(result?.payload.kind === "result", "Unknown result");
  assert(
    result.author !== store.who.publicKey,
    "Independent verifier required",
  );
  assert(
    store.manifest.validators.includes(store.who.publicKey),
    "Only pinned validators may attest verification",
  );
  const payload = result.payload;
  const block = store
    .governance()
    .manifest.blocks.find((b) => b.id === payload.block)!;
  assert(block?.contract?.verifier, "Block has no verifier contract");
  await hydrateTask(
    store,
    block.id,
    () =>
      store.hasBlob(payload.artifact) &&
      [...store.expandRoots(block.inputs)].every(store.hasBlob),
    signal,
    peers,
  );
  signal?.throwIfAborted();
  const artifact = store.blob(result.payload.artifact);
  assert(artifact, "Missing result artifact");
  const sources = [...new Set(block.inputs)];
  const work = workspace(store, sources);
  try {
    const prepared = await prepareVerifier(
      command,
      work.path,
      isolation,
      block.contract.verifierHash !== undefined,
    );
    signal?.throwIfAborted();
    const { recipe } = prepared;
    assert(
      !block.contract.verifierHash || recipe === block.contract.verifierHash,
      "Verifier recipe does not match pinned contract",
    );
    const input = {
      protocol: "bitswarm.verifier.v1",
      block,
      result,
      artifact: JSON.parse(Buffer.from(artifact).toString()),
      workspace: work.path,
      files: work.files,
    };
    const output = await execute({
      command: prepared.command,
      input,
      timeoutMs: block.contract.timeoutMs,
      cwd: work.path,
      isolation,
      image,
      signal,
    });
    const checks = JSON.parse(output.stdout);
    assert(
      validVerificationChecks(checks),
      "Verifier verdict must agree with nonempty boolean check results",
    );
    // A signed event and its report must either both commit or both roll back.
    signal?.throwIfAborted();
    const verifier = block.contract.verifier;
    return store.db.transaction(() => {
      const report = store.addBlob(
        Buffer.from(
          canonical({
            protocol: "bitswarm.verification.v1",
            recipe,
            result: id,
            verifier,
            durationMs: output.durationMs,
            checks,
          }),
        ),
      );
      const event = makeEvent(store.manifest, store.who, {
        kind: "verification",
        result: id,
        verifier,
        passed: checks.passed,
        report,
      });
      store.addEvent(event);
      return event;
    })();
  } finally {
    work.cleanup();
  }
}
