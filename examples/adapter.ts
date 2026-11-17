export {};
// Offline fixture adapter. Replace this executable with your LLM harness.
// It observes supplied bytes; it does not pretend to reverse engineer a target.
const input = JSON.parse(await Bun.stdin.text());
const sources = input.sources.map((s: { id: string; data: string }) => ({
  hash: s.id,
  bytes: Buffer.from(s.data, "base64").length,
}));
console.log(
  JSON.stringify({
    summary: `Fixture evidence for ${input.block.id}; ${sources.length} source objects, ${input.dependencies.length} accepted dependencies.`,
    artifact: {
      kind: "fixture-observation",
      block: input.block.id,
      sources,
      dependencies: input.dependencies.map((d: { result: string }) => d.result),
      findings: [],
      unknowns: ["Real semantic analysis requires an LLM/tool adapter."],
      confidence: "fixture-only",
    },
  }),
);
