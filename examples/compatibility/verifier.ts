import { parameters, checks } from "./oracle.ts";
const input = JSON.parse(await Bun.stdin.text());
const result = checks(
  input.block.id,
  input.artifact,
  parameters(Number(process.argv[2])),
);
console.log(
  JSON.stringify({
    passed: result.every(Boolean),
    checks: result.map((passed, i) => ({
      name: input.block.id + "-" + i,
      passed,
    })),
  }),
);
