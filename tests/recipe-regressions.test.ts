import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareAdapter } from "../src/adapter.ts";
import { prepareVerifier, recipeHash } from "../src/recipe.ts";

test("interpreter entrypoints resolve from the operator directory and task labels remain literal", async () => {
  const jobDirectory = mkdtempSync(join(tmpdir(), "bitswarm-argv-"));
  try {
    const args = await prepareAdapter(
      ["bun", "run", "examples/adapter.ts", "src", "./package.json"],
      jobDirectory,
    );
    expect(args).toEqual([
      "bun",
      "run",
      resolve("examples/adapter.ts"),
      "src",
      resolve("package.json"),
    ]);
    const inline = [
      "node",
      "-e",
      "console.log(process.argv[1])",
      "examples/adapter.ts",
    ];
    expect(await prepareAdapter(inline, jobDirectory, "bwrap")).toEqual(inline);
  } finally {
    rmSync(jobDirectory, { recursive: true, force: true });
  }
});

test("Node recipe pins track the executed Node conditional export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-node-recipe-"));
  try {
    const pkg = join(dir, "node_modules", "encoding"),
      program = join(dir, "verify.mjs");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ exports: { bun: "./bun.mjs", node: "./node.mjs" } }),
    );
    writeFileSync(join(pkg, "bun.mjs"), "export default 1");
    writeFileSync(join(pkg, "node.mjs"), "export default 2");
    writeFileSync(
      program,
      'import answer from "encoding";console.log(answer);',
    );
    const nodeCommand = ["node", program],
      bunCommand = ["bun", program];
    const nodePin = await recipeHash(nodeCommand),
      bunPin = await recipeHash(bunCommand);
    writeFileSync(join(pkg, "node.mjs"), "export default 3");
    expect(await recipeHash(nodeCommand)).not.toBe(nodePin);
    expect(await recipeHash(bunCommand)).toBe(bunPin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prepared pinned verifier executes the same bundle that supplied its digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-pinned-verifier-"));
  try {
    const script = join(dir, "verify.ts"),
      helper = join(dir, "helper.ts");
    writeFileSync(
      script,
      'import {version} from "./helper.ts";console.log(version);',
    );
    writeFileSync(helper, 'export const version = "original";');
    const command = ["bun", script];
    const expected = await recipeHash(command);
    const captured = await prepareVerifier(command, dir, "process");
    const unpinned = await prepareVerifier(command, dir, "process", false);
    writeFileSync(helper, 'export const version = "revised";');
    expect(captured.recipe).toBe(expected);
    expect(await recipeHash(command)).not.toBe(expected);
    expect(Bun.spawnSync(captured.command).stdout.toString().trim()).toBe(
      "original",
    );
    expect(Bun.spawnSync(unpinned.command).stdout.toString().trim()).toBe(
      "revised",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plain executable pins execute the captured binary and retain its basename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-native-verifier-"));
  try {
    const executable = join(dir, "verify-mode");
    writeFileSync(executable, "#!/bin/sh\necho original", { mode: 0o700 });
    const prepared = await prepareVerifier([executable], dir, "process");
    writeFileSync(executable, "#!/bin/sh\necho changed");
    expect(await recipeHash([executable])).not.toBe(prepared.recipe);
    expect(prepared.command[0].split("/").at(-1)).toBe("verify-mode");
    expect(Bun.spawnSync(prepared.command).stdout.toString().trim()).toBe(
      "original",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
