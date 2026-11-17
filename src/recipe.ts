import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { prepareAdapter, scriptArgument } from "./adapter.ts";
import { assert, digest, hash } from "./core.ts";
import type { Isolation } from "./runtime.ts";

async function captureRecipe(command: string[]) {
  assert(command.length, "Missing verifier command");
  const script = scriptArgument(command);
  let program: Uint8Array;
  if (script > 0) {
    const build = await Bun.build({
      entrypoints: [resolve(command[script])],
      target: basename(command[0]) === "node" ? "node" : "bun",
      minify: true,
    });
    assert(
      build.success && build.outputs.length === 1,
      "Verifier recipe bundling failed",
    );
    program = new Uint8Array(await build.outputs[0].arrayBuffer());
  } else {
    const binary = Bun.which(command[0]);
    assert(binary, "Verifier executable not found");
    program = readFileSync(binary);
  }
  const recipe = digest({
    runtime: Bun.version,
    executable: basename(command[0]),
    program: hash(program),
    args: command.slice(1).map((p, i) => (i + 1 === script ? "$PROGRAM" : p)),
  });
  return { recipe, script, program };
}
export async function recipeHash(command: string[]) {
  return (await captureRecipe(command)).recipe;
}
export async function prepareVerifier(
  command: string[],
  directory: string,
  isolation: Isolation,
  pinned = true,
) {
  const { recipe, script, program } = await captureRecipe(command);
  const args = await prepareAdapter(command, directory, "process");
  if (script > 0 && (pinned || isolation !== "process")) {
    const path = join(directory, ".bitswarm-verifier.mjs");
    writeFileSync(path, program, { flag: "wx", mode: 0o600 });
    args[script] = path;
  } else if (script < 0 && pinned) {
    // Some multicall executables select their operation from argv[0].
    const bin = join(directory, ".bitswarm-verifier-bin");
    mkdirSync(bin, { mode: 0o700 });
    args[0] = join(bin, basename(command[0]));
    writeFileSync(args[0], program, { flag: "wx", mode: 0o700 });
  }
  return { recipe, command: args };
}
