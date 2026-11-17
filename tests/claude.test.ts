import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/claude.ts";
import { buildProviderPacket } from "../src/provider-packet.ts";
import { hash } from "../src/core.ts";
import { chunkFile } from "../src/artifacts.ts";

type Input = Parameters<typeof runClaude>[0];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-claude-"));
  const binary = join(dir, "fake-claude"),
    receiptPath = join(dir, "receipt.json");
  writeFileSync(
    binary,
    `#!${process.execPath}
    const {join,dirname} = require('node:path');
    const dir = dirname(process.argv[1]);
    const packet = JSON.parse(await Bun.stdin.text());
    await Bun.write(join(dir, 'observed.json'), JSON.stringify({args:process.argv.slice(2), packet, hasSwarmToken: Boolean(process.env.BITSWARM_TOKEN)}));
    console.log(await Bun.file(join(dir, 'receipt.json')).text());`,
    { mode: 0o700 },
  );
  const receipt = {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: { summary: "Sorted", artifact_json: "[2,3]" },
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2,
    },
    total_cost_usd: 0.0000101,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const input: Input = {
    protocol: "bitswarm.adapter.v1",
    swarm: hash("project"),
    claim: hash("lease"),
    deadline: Date.now() + 10000,
    workspace: dir,
    project: { name: "Numbers", description: "Sort the evidence" },
    block: {
      id: "sort",
      title: "Sort",
      instructions: "Sort",
      inputs: [],
      requires: [],
      capabilities: [],
      contract: {
        maxTokens: 50,
        maxCostMicros: 100,
        timeoutMs: 10000,
        maxAttempts: 1,
      },
    },
    inputs: [],
    sources: [],
    dependencies: [],
    previous: [],
    files: [],
    output: { summary: "", artifact: "", usage: { tokens: 0, costMicros: 0 } },
  };
  return {
    dir,
    binary,
    input,
    receipt,
    run: () => runClaude(input, { binary, model: "sonnet" }),
    change: (patch: Record<string, unknown>) =>
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, ...patch })),
    clean: () => rmSync(dir, { force: true, recursive: true }),
  };
}

test("Claude entrypoint sends scoped evidence and consumes the final structured usage receipt", async () => {
  const f = fixture();
  try {
    const data = Buffer.from("3,2");
    f.input.block.inputs = [hash(data)];
    f.input.inputs = f.input.sources = [
      { id: hash(data), encoding: "base64", data: data.toString("base64") },
    ];
    const child = Bun.spawn([process.execPath, "examples/claude-adapter.ts"], {
      env: {
        PATH: process.env.PATH,
        BITSWARM_TOKEN: "private-fixture",
        BITSWARM_CLAUDE_BINARY: f.binary,
        BITSWARM_CLAUDE_MODEL: "sonnet",
      },
      stdin: new Blob([JSON.stringify(f.input)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      provider: "claude-cli",
      summary: "Sorted",
      artifact: [2, 3],
      usage: { tokens: 21, costMicros: 11 },
    });
    const observed = JSON.parse(
      readFileSync(join(f.dir, "observed.json"), "utf8"),
    );
    for (const flag of [
      "--print",
      "--safe-mode",
      "--restricted",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--json-schema",
    ])
      expect(observed.args).toContain(flag);
    expect(observed.args[observed.args.indexOf("--tools") + 1]).toBe("");
    expect(observed.args[observed.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(observed.args[observed.args.indexOf("--max-budget-usd") + 1]).toBe(
      "0.0001",
    );
    expect(observed.hasSwarmToken).toBe(false);
    expect(observed.packet.sources).toEqual([
      {
        id: hash(data),
        encoding: "utf8",
        data: "3,2",
        size: 3,
        includedBytes: 3,
        truncated: false,
      },
    ]);
    expect(JSON.stringify(observed.packet)).not.toContain(f.dir);
  } finally {
    f.clean();
  }
});

test("Claude rejects invalid usage, over-budget, expired or unsuccessful responses and charges optional input requests", async () => {
  const f = fixture();
  try {
    const optional = hash("optional");
    f.input.block.optionalInputs = [optional];
    f.change({
      structured_output: {
        summary: "Need details",
        artifact_json: JSON.stringify({
          needInput: { root: optional, reason: "Read labels" },
        }),
      },
    });
    expect(await f.run()).toEqual({
      provider: "claude-cli",
      needInput: { root: optional, reason: "Read labels" },
      usage: { tokens: 21, costMicros: 11 },
    });
    f.input.block.optionalInputs = [];
    await expect(f.run()).rejects.toThrow("optional input");
    for (const [patch, message] of [
      [{ usage: { input_tokens: 2, output_tokens: 3 } }, "token usage"],
      [{ usage: { ...f.receipt.usage, input_tokens: 100 } }, "token budget"],
      [{ total_cost_usd: null }, "report estimated cost"],
      [{ total_cost_usd: 1 }, "cost budget"],
      [{ is_error: true }, "successful result"],
      [{ structured_output: null }, "structured output"],
    ] as const) {
      f.change(patch);
      await expect(f.run()).rejects.toThrow(message);
    }
    f.change({});
    f.input.block.contract!.schema = { type: "object" };
    await expect(f.run()).rejects.toThrow("task schema");
    f.input.deadline = 1;
    await expect(f.run()).rejects.toThrow("deadline");
    f.input.block.contract!.maxCostMicros = 0;
    await expect(f.run()).rejects.toThrow("positive estimated cost");
  } finally {
    f.clean();
  }
});

test("tool-free evidence verifies small files, bounds large excerpts and rejects changed or symlinked files", () => {
  const f = fixture();
  try {
    function add(name: string, data: Buffer) {
      const original = join(f.dir, name);
      writeFileSync(original, data);
      const file = chunkFile(original),
        dir = join(f.dir, "sources", file.root),
        path = join(dir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, data);
      f.input.block.inputs.push(file.root);
      f.input.sources.push({
        id: file.root,
        encoding: "base64",
        data: Buffer.from(file.objects[0].data).toString("base64"),
      });
      f.input.files!.push({ hash: file.root, path });
      return { path, original, data };
    }
    add("small.txt", Buffer.from("scoped document"));
    const large = add("large.bin", Buffer.alloc(300_000, 0xff));
    const first = buildProviderPacket(f.input);
    expect(first.sources[0]).toMatchObject({
      data: "scoped document",
      encoding: "utf8",
      truncated: false,
    });
    expect(first.sources[1]).toMatchObject({
      encoding: "base64",
      includedBytes: 16 * 1024,
      size: 300_000,
      truncated: true,
    });
    large.data[100_000] = 0;
    writeFileSync(large.path, large.data);
    expect(() => buildProviderPacket(f.input)).toThrow("hash mismatch");
    unlinkSync(large.path);
    symlinkSync(large.original, large.path);
    expect(() => buildProviderPacket(f.input)).toThrow(
      "assigned workspace path",
    );
    f.input.files![1].path = large.original;
    expect(() => buildProviderPacket(f.input)).toThrow(
      "assigned workspace path",
    );
    f.input.files = [];
    f.input.sources[0].data = "aW52YWxpZA==";
    expect(() => buildProviderPacket(f.input)).toThrow("Source hash mismatch");
  } finally {
    f.clean();
  }
});

test("the evidence budget counts dependencies and reports and excludes unrelated roots", () => {
  const f = fixture();
  try {
    function source(value: string) {
      const data = Buffer.from(value.repeat(20_000));
      return {
        id: hash(data),
        encoding: "base64",
        data: data.toString("base64"),
      };
    }
    f.input.sources = [source("a"), source("b"), source("c")];
    expect(() => buildProviderPacket(f.input)).toThrow(
      "outside assigned block",
    );
    f.input.block.inputs = f.input.sources.map((s) => s.id);
    f.input.dependencies = [
      {
        block: "prep",
        result: hash("result"),
        summary: "Previous result",
        artifact: source("d"),
      },
    ];
    f.input.previous = [
      {
        result: hash("failed"),
        summary: "Rejected",
        reports: [{ detail: "Repeat project tests" }],
      },
    ];
    const packet = buildProviderPacket(f.input);
    expect(packet.dependencies[0].artifact).toMatchObject({
      size: 20_000,
      includedBytes: 16 * 1024,
      truncated: true,
    });
    expect(packet.previous?.[0].reports[0]).toMatchObject({
      includedBytes: 0,
      truncated: true,
      data: "",
    });
    expect(
      packet.sources.reduce(
        (sum, entry) => sum + entry.includedBytes,
        packet.dependencies[0].artifact.includedBytes,
      ),
    ).toBe(64 * 1024);
  } finally {
    f.clean();
  }
});
