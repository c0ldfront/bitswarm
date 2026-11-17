import { runCodex } from "../../src/codex.ts";
const input = JSON.parse(await Bun.stdin.text());
const observations = input.inputs.map((entry: { data: string }) =>
  JSON.parse(Buffer.from(entry.data, "base64").toString()),
);
input.block = {
  ...input.block,
  instructions:
    input.block.instructions +
    "\nHere are all supplied observations: " +
    JSON.stringify(observations) +
    ". Use only these observations. No tool calls needed.",
};
const result = await runCodex(input, { disableShell: true });
console.log(JSON.stringify(result));
