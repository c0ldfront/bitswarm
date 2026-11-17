import { runCodex } from "../../src/codex.ts";
import { runAgent } from "../../src/agent.ts";
const input = JSON.parse(await Bun.stdin.text());
const result =
  process.env.BITSWARM_LLM_DRIVER !== "ollama"
    ? await runCodex(input)
    : await runAgent(input, {
        endpoint:
          process.env.BITSWARM_LLM_ENDPOINT ||
          "http://127.0.0.1:17434/v1/chat/completions",
        model: process.env.BITSWARM_LLM_MODEL || "qwen2.5-coder:7b",
        apiKey: process.env.BITSWARM_LLM_API_KEY,
        maxTokens: input.block.contract.maxTokens,
        maxCostMicros: input.block.contract.maxCostMicros,
        maxTurns: 10,
        commands: { target: ["/usr/bin/basename"] },
        toolIsolation: "bwrap",
      });
const proposals =
  input.block.id === "discover"
    ? [
        {
          reason:
            "Implementation task derived from the model behavioral investigation",
          block: {
            id: "implementation",
            title: "Reconstruct GNU basename",
            instructions:
              result.artifact.instructions +
              '\nProduce artifact.files["main.ts"] as a complete portable Node.js TypeScript CLI implementation compatible with Node 26 native type stripping, with no Bun-specific APIs, with no external commands or dependencies. Parse process.argv.slice(2), write stdout and exit status. The reference command is available through run_tool target. Handle -a/--multiple, -s/--suffix including --suffix=..., -z/--zero, combined short options, -- separator, single-operand optional suffix, errors. No lookup tables; handle arbitrary path strings algorithmically. Match stdout and exit status; stderr text, --help, --version and filesystem input are outside this contract. Previous verification reports contain feedback for retries.',
            requires: ["discover"],
            inputs: input.block.inputs,
            capabilities: ["coding"],
            contract: {
              timeoutMs: 180000,
              maxAttempts: 4,
              maxTokens: 300000,
              maxCostMicros: 0,
              verifier: "basename-parity",
              schema: {
                type: "object",
                properties: {
                  files: {
                    type: "object",
                    properties: { "main.ts": { type: "string" } },
                    required: ["main.ts"],
                    additionalProperties: false,
                  },
                },
                required: ["files"],
                additionalProperties: true,
              },
            },
          },
        },
      ]
    : [];
console.log(
  JSON.stringify({
    ...result,
    artifact: { ...result.artifact, executionTranscript: result.transcript },
    proposals,
  }),
);
