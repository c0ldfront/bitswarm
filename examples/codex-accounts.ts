import { parseArgs } from "node:util";
import { assert } from "../src/core.ts";
import { manageCodexAccount } from "../src/codex-accounts.ts";

const usage =
  "Usage: bun examples/codex-accounts.ts login|status --experimental --account NAME [--device-auth]";
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      experimental: { type: "boolean", default: false },
      account: { type: "string" },
      "device-auth": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) console.log(usage);
  else {
    const [action] = positionals;
    assert(
      positionals.length === 1 &&
        (action === "login" || action === "status") &&
        values.account,
      usage,
    );
    process.exitCode = await manageCodexAccount(
      action,
      values.account,
      values.experimental,
      values["device-auth"],
    );
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Codex account command failed",
  );
  process.exitCode = 1;
}
