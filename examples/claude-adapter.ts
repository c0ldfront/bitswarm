import { runClaude } from "../src/claude.ts";

try {
  const input = JSON.parse(await Bun.stdin.text());
  console.log(JSON.stringify(await runClaude(input)));
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Claude adapter failed",
  );
  process.exitCode = 1;
}
