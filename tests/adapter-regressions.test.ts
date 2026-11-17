import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodex } from "../src/codex.ts";
import { runAgent } from "../src/agent.ts";

function codexFixture() {
  const workspace = mkdtempSync(
    join(tmpdir(), "bitswarm-provider-regression-"),
  );
  const binary = join(workspace, "provider");
  writeFileSync(
    binary,
    `#!${process.execPath}
const args = process.argv.slice(2);
const {packet} = JSON.parse(await Bun.stdin.text());
if (packet.block.publish !== false)
  await Bun.write(args[args.indexOf("--output-last-message") + 1], JSON.stringify({summary:"Completed",artifact_json:JSON.stringify(packet.block.dependency ? packet.dependencies[0].artifact : packet.block.answer)}));
console.log(JSON.stringify({type:"turn.completed",usage:packet.block.usage??{input_tokens:7,output_tokens:2}}));
`,
    { mode: 0o700 },
  );
  return {
    workspace,
    run: (
      block: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) =>
      runCodex(
        { workspace, deadline: Date.now() + 5000, block, ...extra },
        { binary },
      ),
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}
test("Codex preserves array, null and closed-schema artifacts, including legacy tasks and raw dependency evidence", async () => {
  const f = codexFixture();
  try {
    expect(
      (
        await f.run({
          answer: [1, 2],
          usage: { input_tokens: 19990, output_tokens: 5 },
        })
      ).artifact,
    ).toEqual([1, 2]);
    expect(
      (await f.run({ answer: null, optionalInputs: ["optional"] })).artifact,
    ).toBeNull();
    const contract = {
      maxTokens: 20,
      schema: {
        type: "object",
        properties: { value: { type: "integer" } },
        required: ["value"],
        additionalProperties: false,
      },
    };
    expect((await f.run({ answer: { value: 3 }, contract })).artifact).toEqual({
      value: 3,
    });
    const binary = {
      id: "sample",
      encoding: "base64",
      data: Buffer.from([0, 255, 128]).toString("base64"),
    };
    const exactContract = { maxTokens: 20, schema: { const: binary } };
    expect(
      (
        await f.run(
          { dependency: true, contract: exactContract },
          { dependencies: [{ artifact: binary }] },
        )
      ).artifact,
    ).toEqual(binary);
  } finally {
    f.cleanup();
  }
});
test("Codex refuses expired work, inconsistent metering, and stale structured results", async () => {
  const f = codexFixture();
  try {
    await expect(
      f.run({ answer: "late" }, { deadline: Date.now() - 1 }),
    ).rejects.toThrow("deadline");
    await expect(
      f.run({ answer: "bad usage", usage: {}, contract: { maxTokens: 20 } }),
    ).rejects.toThrow("token usage");
    await f.run({ answer: "first", contract: { maxTokens: 20 } });
    await expect(
      f.run({ publish: false, contract: { maxTokens: 20 } }),
    ).rejects.toThrow("did not produce");
    expect(readdirSync(f.workspace)).toEqual(["provider"]);
  } finally {
    f.cleanup();
  }
});
test("HTTP adapter publishes a closed-schema artifact unchanged and rejects inconsistent provider totals", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "bitswarm-http-schema-"));
  let total = 10,
    calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      calls++;
      return Response.json({
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: total },
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "Complete",
                artifact: { value: 42 },
              }),
            },
          },
        ],
      });
    },
  });
  const options = {
    endpoint: server.url.toString(),
    model: "fixture",
    maxTokens: 20,
    maxCostMicros: 0,
  };
  const input = {
    workspace,
    deadline: Date.now() + 5000,
    block: {
      contract: {
        maxTokens: 20,
        maxCostMicros: 0,
        schema: {
          type: "object",
          properties: { value: { type: "integer" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    },
  };
  try {
    const proc = Bun.spawn(["bun", "examples/llm-adapter.ts"], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH,
        BITSWARM_LLM_ENDPOINT: options.endpoint,
        BITSWARM_LLM_MODEL: options.model,
      },
    });
    const [stdout, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout).artifact).toEqual({ value: 42 });
    await expect(
      runAgent({ ...input, deadline: Date.now() - 1 }, options),
    ).rejects.toThrow("deadline");
    expect(calls).toBe(1);
    total = 1;
    await expect(runAgent(input, options)).rejects.toThrow("token usage");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
