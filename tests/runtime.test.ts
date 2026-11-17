import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execute, materializeFiles } from "../src/runtime.ts";
import { installHandler } from "../src/desktop.ts";
test("execution enforces timeout/output limits and does not forward swarm credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-runtime-"));
  const previous = process.env.BITSWARM_TOKEN;
  process.env.BITSWARM_TOKEN = "must-never-reach-an-adapter";
  try {
    const output = await execute({
      command: [
        "bun",
        "-e",
        "console.log(JSON.stringify({token:process.env.BITSWARM_TOKEN||null}))",
      ],
      input: {},
      cwd: dir,
      timeoutMs: 1000,
    });
    expect(JSON.parse(output.stdout).token).toBe(null);
    await expect(
      execute({
        command: ["bun", "-e", "setInterval(()=>{},1000)"],
        input: {},
        cwd: dir,
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out");
    await expect(
      execute({
        command: ["bun", "-e", 'console.log("x".repeat(5000))'],
        input: {},
        cwd: dir,
        timeoutMs: 1000,
        maxOutput: 100,
      }),
    ).rejects.toThrow("limit");
  } finally {
    if (previous === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("materialization rejects escapes and installs an escaped desktop handler into an explicit directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-files-"));
  try {
    expect(() => materializeFiles(dir, { "../escape": "no" })).toThrow(
      "escapes",
    );
    materializeFiles(dir, { "src/module.ts": "export default 1;" });
    materializeFiles(dir, { "src/module.ts": "export default 1;" });
    expect(() =>
      materializeFiles(dir, { "src/module.ts": "overwrite" }),
    ).toThrow("different");
    const result = installHandler(
      dir,
      "/usr/bin/bun",
      "/tmp/a project/src/cli.ts",
    );
    const contents = readFileSync(result.path, "utf8");
    expect(contents).toContain('"/tmp/a project/src/cli.ts" open %u');
    expect(contents).toContain("x-scheme-handler/swarm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
