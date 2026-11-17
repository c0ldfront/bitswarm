import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { materializeFiles } from "../../src/runtime.ts";
const input = JSON.parse(await Bun.stdin.text());
if (input.block.id === "discover") {
  const valid =
    typeof input.artifact.spec === "string" &&
    input.artifact.spec.length > 100 &&
    typeof input.artifact.instructions === "string" &&
    input.artifact.instructions.length > 100;
  console.log(
    JSON.stringify({
      passed: valid,
      checks: [
        {
          name: "Model produced a bounded implementation plan and behavioral specification",
          passed: valid,
        },
      ],
    }),
  );
} else {
  const dir = join(input.workspace, "generated");
  mkdirSync(dir);
  materializeFiles(dir, input.artifact.files);
  const holdout = process.argv.includes("--holdout");
  const seed = Number(
    holdout ? process.argv[process.argv.indexOf("--holdout") + 1] : 731,
  );
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  const cases: string[][] = [
    ["/usr/local/bin/tool"],
    ["/"],
    ["//"],
    ["///"],
    [""],
    ["foo.txt", ".txt"],
    [".txt", ".txt"],
    ["aa", "aa"],
    ["abc", "x"],
    ["a///"],
    ["-a", "/a/b", "/x/y"],
    ["-s", ".txt", "a.txt", "b.txt"],
    ["-z", "hello"],
    ["--", "-hello"],
    ["-a"],
    [],
    ["one", "two", "three"],
    ["--suffix=.txt", "a.txt", "/x/b.txt"],
    ["-as.txt", "a.txt", "b.txt"],
    ["-az", "/a/b", "/x/y"],
  ];
  const symbols = ["a", "b", ".", "-", "_", "é", "東京", " ", "/", "9"];
  for (let n = 0; n < (holdout ? 120 : 30); n++) {
    let path = "";
    for (let i = 0, l = random() % 50; i < l; i++)
      path += symbols[random() % symbols.length];
    cases.push(
      random() % 2 ? ["--", path] : ["-s", ".txt", "--", path + ".txt"],
    );
  }
  const checks = cases.map((args) => {
    const original = spawnSync("/usr/bin/basename", args, {
      encoding: "utf8",
      timeout: 1000,
    });
    const candidate = spawnSync("node", [join(dir, "main.ts"), ...args], {
      encoding: "utf8",
      timeout: 1000,
    });
    return {
      name: JSON.stringify(args),
      passed:
        original.status === candidate.status &&
        original.stdout === candidate.stdout,
      ...(original.status !== candidate.status ||
      original.stdout !== candidate.stdout
        ? {
            expected: { status: original.status, stdout: original.stdout },
            actual: { status: candidate.status, stdout: candidate.stdout },
          }
        : {}),
    };
  });
  console.log(
    JSON.stringify({ passed: checks.every((c) => c.passed), checks }),
  );
}
