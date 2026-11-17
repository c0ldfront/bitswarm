import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execute } from "../src/runtime.ts";
// Explicit integration gate: generic CI need not have namespaces or a Docker daemon.
const integration =
  process.env.BITSWARM_TEST_ISOLATION === "1" ? test : test.skip;
integration(
  "bubblewrap isolates network/home and mounts the selected workspace",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bitswarm-bwrap-"));
    writeFileSync(join(dir, "evidence"), "local-evidence");
    try {
      const result = await execute({
        command: [
          "/bin/sh",
          "-c",
          'test ! -e /home/coldfront/.codex && test "$(cat /work/evidence)" = local-evidence && cat /proc/net/route | wc -l',
        ],
        input: {},
        cwd: dir,
        isolation: "bwrap",
        timeoutMs: 5000,
      });
      expect(Number(result.stdout.trim())).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
integration(
  "Docker runs with no external network and cleans its container after completion",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bitswarm-docker-"));
    try {
      const result = await execute({
        command: [
          "/bin/sh",
          "-c",
          "test ! -e /home/coldfront/.codex && cat /proc/net/route | wc -l",
        ],
        input: {},
        cwd: dir,
        isolation: "docker",
        image: "alpine:3.24",
        timeoutMs: 10000,
      });
      expect(Number(result.stdout.trim())).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
