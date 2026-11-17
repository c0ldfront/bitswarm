import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identity,
  digest,
  hash,
  makeEvent,
  type Manifest,
} from "../src/core.ts";
import { control } from "../src/control.ts";
import { grant, authHeaders, type Auth } from "../src/access.ts";
import { Store } from "../src/store.ts";
import { serve, sync, request } from "../src/network.ts";
test("signed invitations admit only their owner; replay, reader writes and revocation fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-access-")),
    planner = identity(),
    worker = identity(),
    outsider = identity();
  const manifest: Manifest = {
    version: 1,
    name: "Private project",
    description: "Contributor credentials",
    planner: planner.publicKey,
    validators: [planner.publicKey],
    quorum: 1,
    policy: { admission: "invite" },
    blocks: [
      {
        id: "root",
        title: "Root",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  const owner = new Store(join(dir, "owner"), manifest),
    node = new Store(join(dir, "worker"), manifest);
  owner.who = planner;
  node.who = worker;
  control(owner, {
    type: "member",
    key: worker.publicKey,
    role: "worker",
    enabled: true,
  });
  const invitation = grant(
    owner,
    worker.publicKey,
    "worker",
    Date.now() + 60000,
  );
  const auth: Auth = { identity: worker, grant: invitation };
  const server = serve(owner, "", 0);
  try {
    await sync(node, server.url.toString(), auth);
    expect(node.governance().members!.get(worker.publicKey)?.enabled).toBe(
      true,
    );
    await expect(
      request(
        server.url.toString(),
        { identity: outsider, grant: invitation },
        "/v1/manifest",
      ),
    ).rejects.toThrow();
    const headers = authHeaders(auth, "GET", "/v1/manifest", new Uint8Array());
    expect(
      (await fetch(new URL("/v1/manifest", server.url), { headers })).status,
    ).toBe(200);
    expect(
      (await fetch(new URL("/v1/manifest", server.url), { headers })).status,
    ).toBe(400);
    control(owner, {
      type: "member",
      key: worker.publicKey,
      role: "reader",
      enabled: true,
    });
    const reader = {
      identity: worker,
      grant: grant(owner, worker.publicKey, "reader", Date.now() + 60000),
    };
    await expect(
      request(server.url.toString(), reader, "/v1/blobs/" + hash("x"), {
        method: "PUT",
        body: "x",
      }),
    ).rejects.toThrow();
    control(owner, {
      type: "member",
      key: worker.publicKey,
      role: "worker",
      enabled: false,
    });
    await expect(
      request(server.url.toString(), auth, "/v1/manifest"),
    ).rejects.toThrow();
  } finally {
    server.stop(true);
    owner.close();
    node.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("selective transfer fetches only selected tasks and invalid objects cannot starve valid ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-select-")),
    planner = identity();
  const one = hash("one"),
    two = hash("two");
  const manifest: Manifest = {
    version: 1,
    name: "Selective",
    description: "Independent artifacts",
    validators: [planner.publicKey],
    quorum: 1,
    blocks: [one, two].map((id, i) => ({
      id: "task" + i,
      title: "Task",
      instructions: "Inspect",
      requires: [],
      inputs: [id],
      capabilities: [],
    })),
  };
  const a = new Store(join(dir, "a"), manifest),
    b = new Store(join(dir, "b"), manifest);
  const token = crypto.randomUUID();
  a.addBlob(Buffer.from("one"));
  a.addBlob(Buffer.from("two"));
  const server = serve(a, token, 0);
  try {
    await sync(b, server.url.toString(), token, { blocks: ["task0"] });
    expect(b.hasBlob(one)).toBe(true);
    expect(b.hasBlob(two)).toBe(false);
    const invalid = makeEvent(manifest, a.who, {
      kind: "claim",
      block: "task0",
      expires: Date.now() + 10000,
      dependencies: [],
    });
    invalid.signature = "bad";
    a.db
      .query("INSERT INTO events VALUES (?,?)")
      .run(invalid.id, JSON.stringify(invalid));
    const good = makeEvent(manifest, a.who, {
      kind: "claim",
      block: "task1",
      expires: Date.now() + 10000,
      dependencies: [],
    });
    a.addEvent(good);
    const outcome = await sync(b, server.url.toString(), token);
    expect(outcome.invalid).toBeGreaterThan(0);
    expect(b.event(good.id)).toBeDefined();
    expect(b.metrics().quarantine.length).toBeGreaterThan(0);
    const orphan = b.addBlob(Buffer.from("unreferenced"));
    expect(b.collect().removed).toBe(1);
    expect(b.hasBlob(orphan)).toBe(false);
    expect(b.hasBlob(one)).toBe(true);
  } finally {
    server.stop(true);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
