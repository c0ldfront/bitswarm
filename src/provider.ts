import { assert } from "./core.ts";
import { validateSchema } from "./contracts.ts";

export function remainingTime(deadline: number, max: number): number {
  const remaining = deadline - Date.now();
  assert(
    Number.isSafeInteger(remaining) && remaining > 0,
    "Task deadline expired",
  );
  return Math.min(max, remaining);
}

// Older object-based contracts expose tool evidence inside their artifact.
export function artifactWithTranscript(
  artifact: any,
  transcript: unknown[],
  schema?: Record<string, unknown>,
) {
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    Array.isArray(artifact)
  )
    return artifact;
  const withEvidence = { ...artifact, executionTranscript: transcript };
  if (schema && !validateSchema(schema, withEvidence)) return artifact;
  return withEvidence;
}
