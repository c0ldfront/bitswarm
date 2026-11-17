import Ajv, { type ValidateFunction } from "ajv";
import type { Contract } from "./core.ts";
const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
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
      fn = ajv.compile(schema);
      if (cache.size > 1000) cache.clear();
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
    (c.verifierHash === undefined || /^[a-f0-9]{64}$/.test(c.verifierHash)) &&
    (c.verificationQuorum === undefined ||
      (Number.isInteger(c.verificationQuorum) &&
        c.verificationQuorum > 0 &&
        c.verificationQuorum <= 100)) &&
    (!c.verifier || /^[a-zA-Z0-9_-]{1,100}$/.test(c.verifier)) &&
    (!c.schema || validateSchema(c.schema, undefined, true))
  );
}
