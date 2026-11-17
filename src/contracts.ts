import Ajv, { type ValidateFunction } from "ajv";
import type { Contract } from "./core.ts";
const cache = new Map<string, ValidateFunction>();
export function validateSchema(
  schema: Record<string, unknown>,
  value?: unknown,
  compileOnly = false,
): boolean {
  try {
    const key = JSON.stringify(schema);
    let fn = cache.get(key);
    if (!fn) {
      // Schema IDs and nested references belong to this contract. Sharing an Ajv
      // registry would make validation depend on which projects this peer saw first.
      if (schema.$async) return false;
      const ajv = new Ajv({
        allErrors: true,
        strict: true,
        validateFormats: false,
      });
      fn = ajv.compile(schema);
      if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
      cache.set(key, fn);
    }
    return compileOnly || !!fn(value);
  } catch {
    return false;
  }
}
export function validContract(c: Contract): boolean {
  return (
    !!c &&
    Number.isSafeInteger(c.timeoutMs) &&
    c.timeoutMs >= 2000 &&
    c.timeoutMs <= 3_600_000 &&
    Number.isSafeInteger(c.maxAttempts) &&
    c.maxAttempts >= 1 &&
    c.maxAttempts <= 100 &&
    Number.isSafeInteger(c.maxTokens) &&
    c.maxTokens >= 0 &&
    Number.isSafeInteger(c.maxCostMicros) &&
    c.maxCostMicros >= 0 &&
    (c.verifierHash === undefined ||
      (typeof c.verifierHash === "string" &&
        /^[a-f0-9]{64}$/.test(c.verifierHash))) &&
    (c.verificationQuorum === undefined ||
      (Number.isInteger(c.verificationQuorum) &&
        c.verificationQuorum > 0 &&
        c.verificationQuorum <= 100)) &&
    (c.verifier === undefined ||
      (typeof c.verifier === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(c.verifier))) &&
    (c.schema === undefined ||
      (c.schema !== null &&
        typeof c.schema === "object" &&
        !Array.isArray(c.schema) &&
        validateSchema(c.schema, undefined, true)))
  );
}
