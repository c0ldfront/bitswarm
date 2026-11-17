import { existsSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { assert } from "./core.ts";
import type { Isolation } from "./runtime.ts";
// Only locally configured adapter code is bundled. Target artifacts are never
// selected as entrypoints by the network. Isolated jobs mount only the run dir.
export async function prepareAdapter(
  command: string[],
  directory: string,
  isolation: Isolation = "process",
): Promise<string[]> {
  const args = command.map((arg, index) =>
    index > 0 && !arg.startsWith("-") && existsSync(resolve(arg))
      ? resolve(arg)
      : arg,
  );
  const script = args.findIndex(
    (arg, i) => i > 0 && /\.[cm]?[jt]s$/.test(arg) && existsSync(arg),
  );
  if (
    isolation !== "process" &&
    script > 0 &&
    ["bun", "node"].includes(basename(command[0]))
  ) {
    const build = await Bun.build({
      entrypoints: [args[script]],
      target: basename(command[0]) === "node" ? "node" : "bun",
    });
    assert(build.success, "Adapter bundling failed");
    assert(build.outputs.length === 1, "Adapter must bundle to one file");
    const path = join(directory, ".bitswarm-adapter.js");
    writeFileSync(path, await build.outputs[0].text(), { mode: 0o600 });
    args[script] = path;
  }
  return args;
}
