import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
const input = JSON.parse(await Bun.stdin.text());
const block = input.block.id as string;
if (["mix", "score", "route"].includes(block)) {
  const target = input.files.find((f: { path: string }) =>
    f.path.endsWith("/target"),
  );
  if (!target) throw new Error("Missing materialized target executable");
  chmodSync(target.path, 0o700);
  const observed: number[] = [];
  for (let value = 0; value < 64; value++)
    observed.push(
      Number(
        execFileSync(target.path, [block, String(value)], {
          encoding: "utf8",
          timeout: 1000,
        }),
      ),
    );
  console.log(
    JSON.stringify({
      summary: `Exhaustively observed all 64 valid ${block} inputs.`,
      usage: { tokens: 0, costMicros: 0 },
      artifact: {
        mode: block,
        observed,
        files: {
          [block + ".ts"]: `export default ${JSON.stringify(observed)};\n`,
        },
        evidence: {
          source: target.hash,
          method: "Executable observations",
          domain: { min: 0, max: 63 },
          probes: 64,
        },
      },
    }),
  );
} else if (block === "assemble") {
  const files: Record<string, string> = {};
  for (const dep of input.dependencies) {
    const artifact = JSON.parse(
      Buffer.from(dep.artifact.data, "base64").toString(),
    );
    Object.assign(files, artifact.files);
  }
  files["index.ts"] =
    `import mix from './mix.ts';\nimport score from './score.ts';\nimport route from './route.ts';\nconst modes:Record<string,number[]>={mix,score,route};\nconst args=process.argv.slice(2);\nif(args.length!==2||!Object.hasOwn(modes,args[0])||!/^\\s*[+-]?\\d+$/.test(args[1])||!Number.isInteger(Number(args[1]))||Number(args[1])<0||Number(args[1])>63){console.log('invalid');process.exit(2);}\nconsole.log(modes[args[0]][Number(args[1])]);\n`;
  console.log(
    JSON.stringify({
      summary: "Assembled the three observed modules into a CLI application.",
      usage: { tokens: 0, costMicros: 0 },
      artifact: {
        files,
        evidence: {
          dependencies: input.dependencies.map(
            (d: { result: string }) => d.result,
          ),
        },
      },
    }),
  );
} else throw new Error("Unknown reconstruction task");
