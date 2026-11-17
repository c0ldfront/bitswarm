import { hydrateTask } from "./network.ts";
import { recipeHash } from "./recipe.ts";
import { prepareAdapter } from "./adapter.ts";
import { assert, canonical, makeEvent } from "./core.ts";
import { execute, workspace, type Isolation } from "./runtime.ts";
import type { Store } from "./store.ts";
export async function verifyResult(
  store: Store,
  id: string,
  command: string[],
  isolation: Isolation = "bwrap",
  image?: string,
) {
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
  const recipe = await recipeHash(command);
  assert(
    !block.contract.verifierHash || recipe === block.contract.verifierHash,
    "Verifier recipe does not match pinned contract",
  );
  await hydrateTask(
    store,
    block.id,
    () =>
      store.hasBlob(payload.artifact) &&
      [...store.expandRoots(block.inputs)].every(store.hasBlob),
  );
  const artifact = store.blob(result.payload.artifact);
  assert(artifact, "Missing result artifact");
  const sources = [...new Set(block.inputs)];
  const work = workspace(store, sources);
  try {
    const input = {
      protocol: "bitswarm.verifier.v1",
      block,
      result,
      artifact: JSON.parse(Buffer.from(artifact).toString()),
      workspace: work.path,
      files: work.files,
    };
    const output = await execute({
      command: await prepareAdapter(command, work.path, isolation),
      input,
      timeoutMs: block.contract.timeoutMs,
      cwd: work.path,
      isolation,
      image,
    });
    const checks = JSON.parse(output.stdout);
    assert(
      typeof checks.passed === "boolean" && Array.isArray(checks.checks),
      "Verifier must return {passed,checks}",
    );
    const report = store.addBlob(
      Buffer.from(
        canonical({
          protocol: "bitswarm.verification.v1",
          recipe,
          result: id,
          verifier: block.contract.verifier,
          durationMs: output.durationMs,
          checks,
        }),
      ),
    );
    const event = makeEvent(store.manifest, store.who, {
      kind: "verification",
      result: id,
      verifier: block.contract.verifier,
      passed: checks.passed,
      report,
    });
    store.addEvent(event);
    return event;
  } finally {
    work.cleanup();
  }
}
