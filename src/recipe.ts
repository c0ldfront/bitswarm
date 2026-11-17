import { existsSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { assert, digest, hash } from "./core.ts";
export async function recipeHash(command: string[]): Promise<string> {
  assert(command.length, "Missing verifier command");
  const script = command.findIndex(
    (p, i) => i > 0 && /\.[cm]?[jt]s$/.test(p) && existsSync(resolve(p)),
  );
  let content: string;
  if (script > 0) {
    const build = await Bun.build({
      entrypoints: [resolve(command[script])],
      target: "bun",
      minify: true,
    });
    assert(
      build.success && build.outputs.length === 1,
      "Verifier recipe bundling failed",
    );
    content = hash(await build.outputs[0].text());
  } else {
    const binary = Bun.which(command[0]);
    assert(binary, "Verifier executable not found");
    content = hash(readFileSync(binary));
  }
  return digest({
    runtime: Bun.version,
    executable: basename(command[0]),
    program: content,
    args: command.slice(1).map((p, i) => (i + 1 === script ? "$PROGRAM" : p)),
  });
}
