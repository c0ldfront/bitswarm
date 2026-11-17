import { runCodex } from "../src/codex.ts";
console.log(
  JSON.stringify(
    await runCodex(JSON.parse(await Bun.stdin.text()), {
      model: process.env.BITSWARM_CODEX_MODEL,
    }),
  ),
);
