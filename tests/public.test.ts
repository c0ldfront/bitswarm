import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { identity, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { serve, request } from "../src/network.ts";
test("public contributors join with signed work proofs while cheap anonymous requests fail", async () => {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-public-test-")),
    owner = identity(),
    worker = identity();
  const m: Manifest = {
    version: 3,
    name: "Public",
    description: "Resource-priced public admission",
    validators: [owner.publicKey],
    quorum: 1,
    policy: { admission: "public", publicWorkBits: 8 },
    blocks: [
      {
        id: "x",
        title: "X",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  const s = new Store(path, m);
  const server = serve(s, "", 0);
  try {
    await expect(
      request(server.url.toString(), { identity: worker }, "/v1/manifest"),
    ).rejects.toThrow();
    const body = await request(
      server.url.toString(),
      { identity: worker, swarm: s.inventory().swarm, powBits: 8 },
      "/v1/manifest",
    );
    expect(JSON.parse(Buffer.from(body).toString()).name).toBe("Public");
  } finally {
    server.stop(true);
    s.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test("public admission bounds caller work parameters and returns a retryable quota response", async () => {
  const { authHeaders } = await import("../src/access.ts");
  const owner = identity(),
    worker = identity();
  expect(() =>
    authHeaders(
      { identity: worker, powBits: 1000 },
      "GET",
      "/v1/manifest",
      new Uint8Array(),
    ),
  ).toThrow("difficulty");
  const path = mkdtempSync(join(tmpdir(), "bitswarm-public-quota-"));
  const m: Manifest = {
    version: 3,
    name: "Quota",
    description: "Explicit request limit",
    validators: [owner.publicKey],
    quorum: 1,
    policy: { admission: "public", publicWorkBits: 8, requestsPerMinute: 1 },
    blocks: [
      {
        id: "x",
        title: "X",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  const s = new Store(path, m);
  const server = serve(s, "", 0);
  try {
    const headers = () =>
      authHeaders(
        { identity: worker, swarm: s.inventory().swarm, powBits: 8 },
        "GET",
        "/v1/manifest",
        new Uint8Array(),
      );
    expect(
      (await fetch(new URL("/v1/manifest", server.url), { headers: headers() }))
        .status,
    ).toBe(200);
    const denied = await fetch(new URL("/v1/manifest", server.url), {
      headers: headers(),
    });
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
  } finally {
    server.stop(true);
    s.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test("a signed public request cannot be replayed against a different swarm", async () => {
  const { authHeaders } = await import("../src/access.ts");
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-audience-")),
    owner = identity(),
    worker = identity();
  const m: Manifest = {
    version: 3,
    name: "First",
    description: "Request audience binding",
    validators: [owner.publicKey],
    quorum: 1,
    policy: { admission: "public", publicWorkBits: 8 },
    blocks: [
      {
        id: "x",
        title: "X",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  const a = new Store(join(dir, "a"), m),
    b = new Store(join(dir, "b"), { ...m, name: "Second" });
  const sa = serve(a, "", 0),
    sb = serve(b, "", 0);
  try {
    const headers = authHeaders(
      { identity: worker, swarm: a.inventory().swarm, powBits: 8 },
      "GET",
      "/v1/manifest",
      new Uint8Array(),
    );
    expect(
      (await fetch(new URL("/v1/manifest", sa.url), { headers })).status,
    ).toBe(200);
    const denied = await fetch(new URL("/v1/manifest", sb.url), { headers });
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toContain("another swarm");
  } finally {
    sa.stop(true);
    sb.stop(true);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
