import { test, expect } from "bun:test";
import { Buffer } from "node:buffer";
import { validateSchema } from "../src/contracts.ts";
import {
  digest,
  hash,
  identity,
  makeEvent,
  project,
  validateEvent,
  validateManifest,
  type Manifest,
} from "../src/core.ts";

function setup() {
  const validator = identity(),
    worker = identity();
  const manifest: Manifest = {
    version: 4,
    name: "Projection",
    description: "Receipt projection regression",
    validators: [validator.publicKey],
    quorum: 1,
    policy: { reviewTimeoutMs: 5000 },
    blocks: [
      {
        id: "x",
        title: "X",
        instructions: "Work",
        inputs: [],
        requires: [],
        capabilities: [],
        contract: {
          verifier: "checks",
          timeoutMs: 2000,
          maxAttempts: 2,
          maxTokens: 2,
          maxCostMicros: 0,
        },
      },
    ],
  };
  const epoch = digest(manifest),
    options = { epochs: new Map([[epoch, 0]]) };
  const claim = makeEvent(
    manifest,
    worker,
    { kind: "claim", block: "x", epoch, expires: 2100, dependencies: [] },
    100,
  );
  const result = makeEvent(
    manifest,
    worker,
    {
      kind: "result",
      block: "x",
      claim: claim.id,
      artifact: hash("result"),
      summary: "Done",
      usage: { tokens: 1, costMicros: 0 },
    },
    300,
  );
  return { validator, worker, manifest, options, claim, result };
}
test("review rejection releases a verified-contract task; missing machine approval times out", () => {
  const { manifest, claim, result, validator, options } = setup();
  const state = (verdict: "approve" | "reject", now: number) =>
    project(
      manifest,
      [
        claim,
        result,
        makeEvent(
          manifest,
          validator,
          { kind: "review", result: result.id, verdict, reason: "Review" },
          400,
        ),
      ],
      () => true,
      now,
      options,
    )[0];
  expect(state("reject", 500).candidates[0].status).toBe("rejected");
  expect(state("approve", 500).status).toBe("review");
  expect(state("approve", 5400).candidates[0].status).toBe("expired");
  expect(state("approve", 5400).status).toBe("ready");
});
test("signed initial lease obeys the task timeout on receiving peers", () => {
  const { manifest, worker, options } = setup();
  const lease = makeEvent(
    manifest,
    worker,
    {
      kind: "claim",
      block: "x",
      epoch: digest(manifest),
      expires: 10100,
      dependencies: [],
    },
    100,
  );
  validateEvent(lease, manifest, 100);
  expect(project(manifest, [lease], () => true, 2099, options)[0].status).toBe(
    "claimed",
  );
  expect(project(manifest, [lease], () => true, 2101, options)[0].status).toBe(
    "ready",
  );
});
test("a claim from a superseded authority branch cannot exhaust the active branch", () => {
  const { manifest, worker, options } = setup();
  manifest.blocks[0].contract!.maxAttempts = 1;
  const foreignEpoch = hash("old head"),
    lease = makeEvent(
      manifest,
      worker,
      {
        kind: "claim",
        block: "x",
        epoch: foreignEpoch,
        expires: 2000,
        dependencies: [],
      },
      100,
    );
  validateEvent(lease, manifest, 100);
  expect(project(manifest, [lease], () => true, 2001, options)[0].status).toBe(
    "ready",
  );
  expect(
    project(manifest, [], () => true, 2001, {
      ...options,
      prunedAttempts: new Map([["x#" + foreignEpoch, 1]]),
    })[0].status,
  ).toBe("ready");
});
test("projecting an invited swarm recognizes the delegated planner at the claim epoch", () => {
  const { manifest, worker } = setup();
  manifest.policy = { admission: "invite" };
  const epoch = hash("delegated control head");
  const lease = makeEvent(
    manifest,
    worker,
    { kind: "claim", block: "x", epoch, expires: 2000, dependencies: [] },
    100,
  );
  const options = {
    epochs: new Map([[epoch, 1]]),
    authorities: new Map([[epoch, worker.publicKey]]),
  };
  expect(project(manifest, [lease], () => true, 1000, options)[0].status).toBe(
    "claimed",
  );
});
test("contract verifier constraints must be configured and attainable", () => {
  const { manifest } = setup();
  const c = manifest.blocks[0].contract!;
  c.verificationQuorum = 2;
  expect(() => validateManifest(manifest)).toThrow();
  c.verificationQuorum = 1;
  delete c.verifier;
  expect(() => validateManifest(manifest)).toThrow();
  delete c.verificationQuorum;
  c.verifierHash = hash("recipe");
  expect(() => validateManifest(manifest)).toThrow();
  delete c.verifierHash;
  for (const malformed of [false, null, "", []]) {
    Object.assign(c, { schema: malformed });
    expect(() => validateManifest(manifest)).toThrow("task contract");
  }
});
test("manifest and event byte limits match the UTF-8 wire representation", () => {
  const { manifest, worker } = setup();
  const block = { ...manifest.blocks[0], instructions: "あ".repeat(20000) };
  const many = {
    ...manifest,
    blocks: Array.from({ length: 20 }, (_, i) => ({ ...block, id: "b" + i })),
  };
  expect(Buffer.byteLength(JSON.stringify(many))).toBeGreaterThan(1024 * 1024);
  expect(() => validateManifest(many)).toThrow("Manifest too large");
  const report = makeEvent(manifest, worker, {
    kind: "proposal",
    block: { ...block, id: "other" },
    reason: "Explore",
  });
  expect(() => validateEvent(report, manifest)).toThrow("size");
});

test("contract schemas are self-contained across independent swarms", () => {
  const id = "urn:bitswarm:findings";
  expect(validateSchema({ $id: id, type: "string" }, "text")).toBe(true);
  expect(validateSchema({ $id: id, type: "integer" }, 42)).toBe(true);
  expect(validateSchema({ $ref: id }, undefined, true)).toBe(false);
  expect(
    validateSchema({ $async: true, type: "integer" }, undefined, true),
  ).toBe(false);
});
