import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
test("real HTTP adapter runs a tool loop, records usage and returns provider findings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-agent-"));
  writeFileSync(join(dir, "evidence.txt"), "observed bytes");
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      calls++;
      if (calls === 1)
        return Response.json({
          usage: { total_tokens: 10, prompt_tokens: 8, completion_tokens: 2 },
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"evidence.txt"}',
                    },
                  },
                ],
              },
            },
          ],
        });
      expect(body.messages.at(-1).content).toContain("observed bytes");
      return Response.json({
        usage: { total_tokens: 20, prompt_tokens: 15, completion_tokens: 5 },
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "Observed evidence",
                artifact: { findings: ["observed bytes"] },
              }),
            },
          },
        ],
      });
    },
  });
  try {
    const result = await runAgent(
      { workspace: dir, deadline: Date.now() + 10000, block: { id: "x" } },
      {
        endpoint: new URL("/v1/chat/completions", server.url).toString(),
        model: "mock-provider",
        maxTokens: 100,
        maxCostMicros: 100,
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 1000000,
      },
    );
    expect(result.usage).toEqual({ tokens: 30, costMicros: 30 });
    expect(result.transcript).toHaveLength(1);
    expect(calls).toBe(2);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("agent tools cannot read outside their workspace and budget overflow stops the loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-agent-limit-"));
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      calls++;
      if (calls === 1)
        return Response.json({
          usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 },
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "escape",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"/etc/passwd"}',
                    },
                  },
                ],
              },
            },
          ],
        });
      expect(body.messages.at(-1).content).toContain("escapes workspace");
      return Response.json({
        usage: {
          total_tokens: 1000,
          prompt_tokens: 900,
          completion_tokens: 100,
        },
        choices: [{ message: { role: "assistant", content: "{}" } }],
      });
    },
  });
  try {
    await expect(
      runAgent(
        { workspace: dir, deadline: Date.now() + 10000, block: {} },
        {
          endpoint: server.url.toString(),
          model: "mock-provider",
          maxTokens: 10,
          maxCostMicros: 10,
        },
      ),
    ).rejects.toThrow("budget");
    expect(calls).toBe(2);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
