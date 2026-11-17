import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, hash, makeEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { claim, submit } from "../src/worker.ts";
import { recipeHash } from "../src/recipe.ts";
test("protocol 3 requires independent verifier quorum and the exact pinned recipe", () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-quorum-")),
    a = identity(),
    b = identity(),
    worker = identity();
  const recipe = hash("trusted verifier");
  const m: Manifest = {
    version: 3,
    name: "Quorum",
    description: "Do not trust one verifier",
    validators: [a.publicKey, b.publicKey],
    quorum: 2,
    blocks: [
      {
        id: "x",
        title: "X",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
        contract: {
          timeoutMs: 10000,
          maxAttempts: 2,
          maxTokens: 0,
          maxCostMicros: 0,
          verifier: "checks",
          verifierHash: recipe,
        },
      },
    ],
  };
  const s = new Store(dir, m);
  try {
    s.who = worker;
    const lease = claim(s, "x");
    const result = submit(s, lease.id, Buffer.from("{}"), "Evidence");
    for (const key of [a, b])
      s.addEvent(
        makeEvent(m, key, {
          kind: "review",
          result: result.id,
          verdict: "approve",
          reason: "Checked",
        }),
      );
    const report = (value: string) =>
      s.addBlob(
        Buffer.from(
          JSON.stringify({
            result: result.id,
            verifier: "checks",
            recipe: value,
            checks: {
              passed: true,
              checks: [{ name: "reproduction", passed: true }],
            },
          }),
        ),
      );
    for (const key of [a, b])
      s.addEvent(
        makeEvent(m, key, {
          kind: "verification",
          result: result.id,
          verifier: "checks",
          passed: true,
          report: report(hash("wrong")),
        }),
      );
    expect(s.state()[0].status).toBe("review");
    s.addEvent(
      makeEvent(m, a, {
        kind: "verification",
        result: result.id,
        verifier: "checks",
        passed: true,
        report: report(recipe),
      }),
    );
    expect(s.state()[0].status).toBe("review");
    s.addEvent(
      makeEvent(m, b, {
        kind: "verification",
        result: result.id,
        verifier: "checks",
        passed: true,
        report: report(recipe),
      }),
    );
    expect(s.state()[0].status).toBe("accepted");
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("recipe hashes include imported helper code rather than only the entrypoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-recipe-"));
  try {
    const file = join(dir, "verify.ts");
    writeFileSync(
      file,
      'import {value} from "./helper.ts";console.log(value);',
    );
    writeFileSync(join(dir, "helper.ts"), "export const value=1;");
    const first = await recipeHash(["bun", file]);
    writeFileSync(join(dir, "helper.ts"), "export const value=2;");
    const second = await recipeHash(["bun", file]);
    expect(first).not.toBe(second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
