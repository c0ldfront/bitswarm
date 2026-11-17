import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, identity, makeEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";

function fileIndex(name: string) {
  const contents = Buffer.from(name);
  const chunk = hash(contents);
  const index = Buffer.from(
    JSON.stringify({
      type: "bitswarm.file.v1",
      name,
      size: contents.length,
      sha256: chunk,
      chunks: [chunk],
    }),
  );
  return { chunk, index, root: hash(index) };
}

const validator = identity();
const input = fileIndex("selected.txt");
const prerequisite = fileIndex("prerequisite.txt");
const manifest: Manifest = {
  version: 4,
  name: "Selection lifecycle",
  description: "Inspect an accepted summary",
  validators: [validator.publicKey],
  quorum: 1,
  blocks: [
    { id: "describe", requires: [], inputs: [prerequisite.root] },
    { id: "combine", requires: ["describe"], inputs: [input.root] },
  ].map((block) => ({
    ...block,
    title: block.id,
    instructions: "Summarize the input",
    capabilities: [],
  })),
};

function participation(directory: string, ...args: string[]) {
  const command = Bun.spawnSync(
    ["bun", "src/cli.ts", "participation", "--state", directory, ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(command.stderr.toString()).toBe("");
  expect(command.exitCode).toBe(0);
  return JSON.parse(command.stdout.toString()).profile;
}

test("legacy selection survives an upload-only change and stays cleared after switching to automatic tasks", () => {
  const directory = mkdtempSync(join(tmpdir(), "bitswarm-selection-"));
  const store = new Store(directory, manifest);
  try {
    store.select(["describe"]);
    expect(store.wanted()).toEqual(new Set([prerequisite.root]));
    expect(participation(directory, "--upload", "results").only).toEqual([
      "describe",
    ]);
    store.subscribe("combine");
    participation(directory, "--download", "metadata");
    expect(store.wanted()).toEqual(new Set());
    participation(directory, "--download", "tasks");
    expect(participation(directory).only).toBeUndefined();
    expect(store.wanted()).toEqual(new Set([input.root]));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task selection expands declared input indexes and treats receipt bodies as opaque", () => {
  const directory = mkdtempSync(join(tmpdir(), "bitswarm-selection-"));
  const store = new Store(directory, manifest);
  try {
    const artifact = fileIndex("result describes a file");
    const report = fileIndex("report describes a file");
    for (const file of [input, prerequisite, artifact, report])
      store.addBlob(file.index);
    const result = makeEvent(manifest, store.who, {
      kind: "result",
      block: "describe",
      claim: hash(Buffer.from("receipt")),
      summary: "Found a file index",
      artifact: artifact.root,
    });
    store.addEvent(result);
    store.addEvent(
      makeEvent(manifest, validator, {
        kind: "verification",
        result: result.id,
        report: report.root,
        verifier: "describe",
        passed: true,
      }),
    );
    store.configure({
      download: "tasks",
      upload: "results",
      only: ["combine"],
    });
    expect(store.wanted()).toEqual(
      new Set([input.root, input.chunk, artifact.root, report.root]),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
