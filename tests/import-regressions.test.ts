import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFile } from "../src/artifacts.ts";
import { Store } from "../src/store.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bitswarm-seed-"));
  const state = join(root, "state");
  const manifest = join(root, "project.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      version: 4,
      name: "Import",
      description: "Import a file",
      validators: [],
      quorum: 1,
      policy: { storageBytes: 300000 },
      blocks: [
        {
          id: "read",
          title: "Read",
          instructions: "Read",
          requires: [],
          inputs: [],
          capabilities: [],
        },
      ],
    }),
  );
  const small = join(root, "small"),
    large = join(root, "large");
  writeFileSync(small, "Small input");
  writeFileSync(
    large,
    Buffer.concat([Buffer.alloc(262144, 1), Buffer.alloc(65536, 2)]),
  );
  const run = (command: string, ...args: string[]) =>
    Bun.spawnSync(
      [process.execPath, "src/cli.ts", command, "--state", state, ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
  return {
    state,
    manifest,
    small,
    large,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("failed put leaves the prior objects and pins intact", () => {
  const f = setup();
  try {
    expect(f.run("init", "--manifest", f.manifest).exitCode).toBe(0);
    expect(f.run("put", "--file", f.small).exitCode).toBe(0);
    const store = new Store(f.state);
    try {
      const before = store.inventory().blobs;
      const pins = store.db.query("SELECT id FROM pins ORDER BY id").values();
      expect(f.run("put", "--file", f.large).stderr.toString()).toContain(
        "Blob storage limit reached",
      );
      expect(store.inventory().blobs).toEqual(before);
      expect(
        store.db.query("SELECT id FROM pins ORDER BY id").values(),
      ).toEqual(pins);
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test("failed multi-file initialization can be retried in place with a corrected input and the same identity", () => {
  const f = setup();
  try {
    const args = [
      "--manifest",
      f.manifest,
      "--taskFile",
      "read=" + f.small,
      "--input",
      f.large,
    ];
    expect(f.run("keygen").exitCode).toBe(0);
    const key = readFileSync(join(f.state, "identity.json"), "utf8");
    expect(f.run("init", ...args).stderr.toString()).toContain(
      "Blob storage limit reached",
    );
    expect(existsSync(join(f.state, "manifest.json"))).toBe(false);
    writeFileSync(f.large, "Corrected input");
    const retry = f.run("init", ...args);
    expect(retry.stderr.toString()).toBe("");
    expect(retry.exitCode).toBe(0);
    const store = new Store(f.state);
    try {
      const objects = new Set<string>();
      for (const path of [f.small, f.large])
        planFile(path).seed((_, id) => objects.add(id));
      expect(store.inventory().blobs).toEqual([...objects].sort());
      expect(readFileSync(join(f.state, "identity.json"), "utf8")).toBe(key);
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test("a committed import recovers its pinned manifest after an interrupted publication", () => {
  const f = setup();
  try {
    expect(
      f.run("init", "--manifest", f.manifest, "--input", f.small).exitCode,
    ).toBe(0);
    const path = join(f.state, "manifest.json");
    const manifest = readFileSync(path, "utf8");
    unlinkSync(path);
    expect(
      f
        .run("init", "--manifest", f.manifest, "--input", f.large)
        .stderr.toString(),
    ).toContain("another swarm");
    const store = new Store(f.state);
    try {
      expect(readFileSync(path, "utf8")).toBe(manifest);
      expect(store.hasBlob(planFile(f.small).root)).toBe(true);
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test("concurrent keygen commands return the same complete identity", async () => {
  const f = setup();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => {
        const child = Bun.spawn(
          [process.execPath, "src/cli.ts", "keygen", "--state", f.state],
          { stdout: "pipe", stderr: "pipe" },
        );
        return Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
      }),
    );
    const stored = JSON.parse(
      readFileSync(join(f.state, "identity.json"), "utf8"),
    );
    for (const [code, stdout, stderr] of results) {
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).publicKey).toBe(stored.publicKey);
    }
  } finally {
    f.cleanup();
  }
});

test("concurrent initializations pin exactly one swarm and keep only its inputs", async () => {
  const f = setup();
  try {
    writeFileSync(f.large, "Second candidate");
    const inputs = [f.small, f.large];
    const results = await Promise.all(
      inputs.map(async (input) => {
        const process = Bun.spawn(
          [
            "bun",
            "src/cli.ts",
            "init",
            "--state",
            f.state,
            "--manifest",
            f.manifest,
            "--input",
            input,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [code, stderr] = await Promise.all([
          process.exited,
          new Response(process.stderr).text(),
        ]);
        return { code, stderr, input };
      }),
    );
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.find((result) => result.code !== 0)?.stderr).toContain(
      "another swarm",
    );
    const store = new Store(f.state);
    try {
      const ids: string[] = [];
      const winner = planFile(
        results.find((result) => result.code === 0)!.input,
      );
      winner.seed((_, id) => ids.push(id));
      expect(store.manifest.blocks[0].inputs).toEqual([winner.root]);
      expect(store.inventory().blobs).toEqual(ids.sort());
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});
