import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, ExecutionError, type Isolation } from "../src/runtime.ts";

test("input serialization failure occurs before a tool is started", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bitswarm-packet-"));
  const marker = join(cwd, "started");
  try {
    await expect(
      execute({
        command: ["bun", "-e", 'await Bun.write("started","yes")'],
        cwd,
        input: 1n,
        timeoutMs: 500,
      }),
    ).rejects.toThrow();
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const isolated = process.env.BITSWARM_TEST_ISOLATION === "1" ? test : test.skip;
isolated(
  "isolated verifiers receive original signed evidence and relocated file pointers",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bitswarm-evidence-"));
    try {
      const path = join(cwd, "example.png");
      const artifact = { example: path, workspace: cwd, files: [{ path }] };
      const result = await execute({
        command: ["/bin/cat"],
        cwd,
        input: {
          protocol: "bitswarm.verifier.v1",
          workspace: cwd,
          files: [{ path }],
          artifact,
        },
        isolation: "bwrap",
        timeoutMs: 2000,
      });
      expect(JSON.parse(result.stdout)).toEqual({
        protocol: "bitswarm.verifier.v1",
        workspace: "/work",
        files: [{ path: "/work/example.png" }],
        artifact,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test("unsupported isolation settings abort execution", async () => {
  for (const mode of ["bubblewrap", "", null])
    await expect(
      execute({
        command: ["bun", "-e", ""],
        timeoutMs: 500,
        input: {},
        isolation: mode as Isolation,
      }),
    ).rejects.toThrow("isolation mode");
});
test("oversized stderr diagnostics preserve the first 64 KiB", async () => {
  const result = await execute({
    command: [
      "bun",
      "-e",
      'process.stderr.write("diagnostic"+".".repeat(100000));process.exitCode=1',
    ],
    timeoutMs: 1000,
    input: {},
  }).catch((e) => e);
  expect(result).toBeInstanceOf(ExecutionError);
  expect(result.stderr).toStartWith("diagnostic");
  expect(Buffer.byteLength(result.stderr)).toBe(65536);
});
