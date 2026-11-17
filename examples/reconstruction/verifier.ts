import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { materializeFiles } from "../../src/runtime.ts";
const input = JSON.parse(await Bun.stdin.text());
const target = input.files.find((f: { path: string }) =>
  f.path.endsWith("/target"),
);
if (!target) throw new Error("Missing target");
chmodSync(target.path, 0o700);
const generated = join(input.workspace, "generated");
mkdirSync(generated);
materializeFiles(generated, input.artifact.files);
const checks: { name: string; passed: boolean }[] = [];
if (input.block.id === "assemble") {
  for (const mode of ["mix", "score", "route"])
    for (let value = 0; value < 64; value++) {
      const reference = execFileSync(target.path, [mode, String(value)], {
        encoding: "utf8",
      });
      const actual = execFileSync(
        "bun",
        [join(generated, "index.ts"), mode, String(value)],
        { encoding: "utf8" },
      );
      checks.push({ name: `${mode}(${value})`, passed: reference === actual });
    }
  for (const args of [
    [],
    ["bad", "1"],
    ["mix", "64"],
    ["mix", "-1"],
    ["mix", "x"],
    ["mix", "1", "extra"],
    ["mix", ""],
    ["mix", " 2"],
    ["mix", "+2"],
    ["mix", "2 "],
    ["__proto__", "1"],
    ["constructor", "1"],
    ["toString", "1"],
  ]) {
    const reference = spawnSync(target.path, args, { encoding: "utf8" });
    const actual = spawnSync("bun", [join(generated, "index.ts"), ...args], {
      encoding: "utf8",
    });
    checks.push({
      name: `invalid/boundary ${JSON.stringify(args)}`,
      passed:
        reference.status === actual.status &&
        reference.stdout === actual.stdout,
    });
  }
} else {
  const mode = input.block.id;
  const observed = input.artifact.observed;
  for (let value = 0; value < 64; value++)
    checks.push({
      name: `${mode}(${value})`,
      passed:
        observed[value] ===
        Number(
          execFileSync(target.path, [mode, String(value)], {
            encoding: "utf8",
          }),
        ),
    });
}
console.log(JSON.stringify({ passed: checks.every((c) => c.passed), checks }));
