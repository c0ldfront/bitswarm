import { existsSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { assert } from "./core.ts";
import type { Isolation } from "./runtime.ts";

const optionsWithValue = new Set([
  "-r",
  "--require",
  "--import",
  "--preload",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--config",
  "--cwd",
]);

export function scriptArgument(command: string[]): number {
  const runtime = basename(command[0]);
  if (runtime !== "bun" && runtime !== "node") return -1;
  for (let i = 1; i < command.length; i++) {
    const arg = command[i];
    // In eval/print/stdin mode every remaining positional belongs to the program.
    if (arg === "-" || /^-[ep]/.test(arg) || /^--(eval|print)(=|$)/.test(arg))
      return -1;
    if (optionsWithValue.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-") || (i === 1 && runtime === "bun" && arg === "run"))
      continue;
    return /\.[cm]?[jt]sx?$/.test(arg) && existsSync(resolve(arg)) ? i : -1;
  }
  return -1;
}

// Only locally configured adapter code is bundled. Target artifacts are never
// selected as entrypoints by the network. Isolated jobs mount only the run dir.
export async function prepareAdapter(
  command: string[],
  directory: string,
  isolation: Isolation = "process",
): Promise<string[]> {
  const runtime = basename(command[0]);
  const interpreted = runtime === "bun" || runtime === "node";
  const script = scriptArgument(command);
  const args = command.map((arg, index) => {
    if (index === 0 || arg.startsWith("-")) return arg;
    // Explicit file operands may be relative to the operator's directory. Preserve
    // literal program arguments even if a file or directory shares their name.
    if (
      interpreted &&
      index !== script &&
      !arg.startsWith("./") &&
      !arg.startsWith("../")
    )
      return arg;
    return existsSync(resolve(arg)) ? resolve(arg) : arg;
  });
  if (isolation !== "process" && script > 0) {
    const build = await Bun.build({
      entrypoints: [args[script]],
      target: runtime === "node" ? "node" : "bun",
    });
    assert(build.success, "Adapter bundling failed");
    assert(build.outputs.length === 1, "Adapter must bundle to one file");
    const path = join(directory, ".bitswarm-adapter.js");
    writeFileSync(path, await build.outputs[0].text(), { mode: 0o600 });
    args[script] = path;
  }
  return args;
}
