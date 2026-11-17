import { describe, test, expect } from "bun:test";
import {
  canonical,
  digest,
  hash,
  identity,
  makeEvent,
  project,
  validateEvent,
  validateManifest,
  type Event,
  type Identity,
  type Manifest,
  type Payload,
} from "../src/core.ts";

export function fixture() {
  const worker = identity(),
    a = identity(),
    b = identity();
  const manifest: Manifest = {
    version: 1,
    name: "test",
    description: "A test swarm",
    validators: [a.publicKey, b.publicKey],
    quorum: 2,
    blocks: [
      {
        id: "root",
        title: "Root",
        instructions: "Inspect evidence",
        requires: [],
        inputs: [],
        capabilities: [],
      },
      {
        id: "child",
        title: "Child",
        instructions: "Integrate results",
        requires: ["root"],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  return { worker, a, b, manifest };
}
function chain(
  m: Manifest,
  w: Identity,
  a: Identity,
  b: Identity,
  artifact = hash("findings"),
) {
  const claim = makeEvent(
    m,
    w,
    { kind: "claim", block: "root", expires: 2000, dependencies: [] },
    1000,
  );
  const result = makeEvent(
    m,
    w,
    {
      kind: "result",
      block: "root",
      claim: claim.id,
      artifact,
      summary: "Evidence",
    },
    1100,
  );
  const votes = [a, b].map((v) =>
    makeEvent(
      m,
      v,
      {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Evidence reproduced",
      },
      1200,
    ),
  );
  return { claim, result, votes, events: [claim, result, ...votes] };
}
describe("signed protocol and deterministic work state", () => {
  test("canonical objects ignore key insertion order", () =>
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 })));
  test("rejects tampering and wrong swarm", () => {
    const { manifest, worker } = fixture();
    const e = makeEvent(
      manifest,
      worker,
      { kind: "claim", block: "root", expires: 2000, dependencies: [] },
      1000,
    );
    validateEvent(e, manifest, 1500);
    expect(() => validateEvent({ ...e, time: 999 }, manifest, 1500)).toThrow();
    expect(() =>
      validateEvent(e, { ...manifest, name: "other" }, 1500),
    ).toThrow();
  });
  test("rejects cycles, unknown dependencies, duplicate validators and minority quorums", () => {
    const { manifest } = fixture();
    validateManifest(manifest);
    expect(() => validateManifest({ ...manifest, quorum: 1 })).toThrow();
    expect(() =>
      validateManifest({
        ...manifest,
        validators: [manifest.validators[0], manifest.validators[0]],
      }),
    ).toThrow();
    expect(() =>
      validateManifest({
        ...manifest,
        blocks: manifest.blocks.map((b) => ({ ...b, requires: ["child"] })),
      }),
    ).toThrow();
    expect(() =>
      validateManifest({
        ...manifest,
        blocks: [{ ...manifest.blocks[0], requires: ["missing"] }],
      }),
    ).toThrow();
  });
  test("a crashed worker releases its claim", () => {
    const { manifest, worker } = fixture();
    const e = makeEvent(
      manifest,
      worker,
      { kind: "claim", block: "root", expires: 2000, dependencies: [] },
      1000,
    );
    expect(project(manifest, [e], () => true, 1500)[0].status).toBe("claimed");
    expect(project(manifest, [e], () => true, 2001)[0].status).toBe("ready");
  });
  test("out-of-order delivery converges and requires artifacts plus independent quorum", () => {
    const { manifest, worker, a, b } = fixture();
    const { events } = chain(manifest, worker, a, b);
    expect(
      project(manifest, events.slice(0, 3), () => true, 1500)[0].status,
    ).toBe("review");
    expect(project(manifest, events, () => false, 1500)[0].status).toBe(
      "claimed",
    );
    const state = project(manifest, events, () => true, 1500);
    expect(state[0].status).toBe("accepted");
    expect(state[1].status).toBe("ready");
    expect(
      canonical(project(manifest, [...events].reverse(), () => true, 1500)),
    ).toBe(canonical(state));
    expect(
      canonical(project(manifest, [...events, ...events], () => true, 1500)),
    ).toBe(canonical(state));
  });
  test("self-review cannot meet quorum and unauthorized reviewers are rejected", () => {
    const { manifest, worker, a, b } = fixture();
    const { events, result } = chain(manifest, a, a, b);
    expect(project(manifest, events, () => true, 1500)[0].status).toBe(
      "review",
    );
    const review = makeEvent(
      manifest,
      worker,
      {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Trust me",
      },
      1200,
    );
    expect(() => validateEvent(review, manifest, 1500)).toThrow();
  });
  test("conflicting approvals dispute a block and block descendants", () => {
    const { manifest, worker, a, b } = fixture();
    const first = chain(manifest, worker, a, b);
    const second = chain(manifest, worker, a, b, hash("different"));
    const childClaim = makeEvent(
      manifest,
      worker,
      {
        kind: "claim",
        block: "child",
        expires: 2500,
        dependencies: [first.result.id],
      },
      1300,
    );
    const states = project(
      manifest,
      [...first.events, ...second.events, childClaim],
      () => true,
      1500,
    );
    expect(states[0].status).toBe("disputed");
    expect(states[1].status).toBe("blocked");
    expect(states[1].claims).toHaveLength(0);
  });
  test("equivocation and repeated votes never multiply a validator", () => {
    const { manifest, worker, a, b } = fixture();
    const { events, result } = chain(manifest, worker, a, b);
    const duplicate = makeEvent(
      manifest,
      a,
      {
        kind: "review",
        result: result.id,
        verdict: "approve",
        reason: "Again",
      },
      1250,
    );
    expect(
      project(manifest, [...events, duplicate], () => true, 1500)[0]
        .candidates[0].approvals,
    ).toHaveLength(2);
    const reject = makeEvent(
      manifest,
      a,
      {
        kind: "review",
        result: result.id,
        verdict: "reject",
        reason: "Conflicting vote",
      },
      1300,
    );
    expect(
      project(manifest, [...events, reject], () => true, 1500)[0].status,
    ).toBe("review");
  });
  test("foreign, expired and dependency-free results cannot unlock work", () => {
    const { manifest, worker, a, b } = fixture();
    const { events, claim } = chain(manifest, worker, a, b);
    const forged = makeEvent(
      manifest,
      b,
      {
        kind: "result",
        block: "root",
        claim: claim.id,
        artifact: hash("x"),
        summary: "Stolen lease",
      },
      1100,
    );
    const late = makeEvent(
      manifest,
      worker,
      {
        kind: "result",
        block: "root",
        claim: claim.id,
        artifact: hash("x"),
        summary: "Late",
      },
      2001,
    );
    const child = makeEvent(
      manifest,
      worker,
      { kind: "claim", block: "child", expires: 2500, dependencies: [] },
      1300,
    );
    const state = project(
      manifest,
      [...events, forged, late, child],
      () => true,
      1500,
    );
    expect(state[0].candidates.filter((c) => !c.eligible)).toHaveLength(2);
    expect(state[1].claims).toHaveLength(0);
  });
  test("future-dated events and excessive lease lengths are rejected", () => {
    const { manifest, worker } = fixture();
    const payload: Payload = {
      kind: "claim",
      block: "root",
      expires: 5_000_000,
      dependencies: [],
    };
    expect(() =>
      validateEvent(makeEvent(manifest, worker, payload, 1000), manifest, 1500),
    ).toThrow();
    expect(() =>
      validateEvent(
        makeEvent(manifest, worker, { ...payload, expires: 50_000 }, 40_000),
        manifest,
        1000,
      ),
    ).toThrow();
  });
});
