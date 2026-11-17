import { digest } from "./core.ts";
export function hasWork(value: unknown, bits: number): boolean {
  const n = BigInt("0x" + digest(value));
  return n < 1n << BigInt(256 - bits);
}
