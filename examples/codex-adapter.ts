import { parseArgs } from "node:util";
import { runCodex } from "../src/codex.ts";
try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      experimental: { type: "boolean", default: false },
      account: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun examples/codex-adapter.ts [--experimental --account NAME]",
    );
  } else {
    if (values.account !== undefined && !values.experimental)
      throw new Error("Named Codex accounts require --experimental");
    if (values.experimental && !values.account)
      throw new Error("--experimental requires --account NAME");
    const packet = JSON.parse(await Bun.stdin.text());
    console.log(JSON.stringify(await runCodex(packet, values)));
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Codex adapter failed",
  );
  process.exitCode = 1;
}
