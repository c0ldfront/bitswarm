import { readFileSync } from "node:fs";
import type { Isolation } from "../src/runtime.ts";
import { artifactWithTranscript } from "../src/provider.ts";
import { runAgent } from "../src/agent.ts";
const input = JSON.parse(await Bun.stdin.text());
const endpoint = process.env.BITSWARM_LLM_ENDPOINT;
const model = process.env.BITSWARM_LLM_MODEL;
if (!endpoint || !model)
  throw new Error(
    "Set BITSWARM_LLM_ENDPOINT (full chat/completions URL) and BITSWARM_LLM_MODEL",
  );
const contract = input.block.contract || {
  maxTokens: 16000,
  maxCostMicros: 1_000_000,
};
const result = await runAgent(input, {
  endpoint,
  model,
  apiKey: process.env.BITSWARM_LLM_API_KEY,
  maxTokens: contract.maxTokens,
  maxCostMicros: contract.maxCostMicros,
  toolIsolation: (process.env.BITSWARM_LLM_TOOL_ISOLATION ||
    "bwrap") as Isolation,
  toolImage: process.env.BITSWARM_LLM_TOOL_IMAGE,
  maxTurns: Number(process.env.BITSWARM_LLM_MAX_TURNS || 12),
  inputMicrosPerMillion: Number(
    process.env.BITSWARM_LLM_INPUT_MICROS_PER_MILLION || 0,
  ),
  outputMicrosPerMillion: Number(
    process.env.BITSWARM_LLM_OUTPUT_MICROS_PER_MILLION || 0,
  ),
  commands: process.env.BITSWARM_LLM_TOOLS
    ? JSON.parse(readFileSync(process.env.BITSWARM_LLM_TOOLS, "utf8"))
    : undefined,
});
console.log(
  JSON.stringify({
    ...result,
    artifact: artifactWithTranscript(
      result.artifact,
      result.transcript,
      contract.schema,
    ),
  }),
);
