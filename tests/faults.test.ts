import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  identity,
  makeEvent,
  digest,
  validateEvent,
  type Manifest,
} from "../src/core.ts";
import { Store } from "../src/store.ts";
import { claim, submit } from "../src/worker.ts";
import { serve, sync } from "../src/network.ts";
test("partitioned duplicate work converges to a dispute and blocks descendants on both replicas", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-partition-")),
    key = identity();
  const m: Manifest = {
    version: 2,
    name: "Partition",
    description: "Split and heal",
    validators: [key.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "root",
        title: "Root",
        instructions: "Inspect",
        requires: [],
        inputs: [],
        capabilities: [],
      },
      {
        id: "child",
        title: "Child",
        instructions: "Integrate",
        requires: ["root"],
        inputs: [],
        capabilities: [],
      },
    ],
  };
  const a = new Store(join(dir, "a"), m),
    b = new Store(join(dir, "b"), m);
  const token = crypto.randomUUID();
  const server = serve(a, token, 0);
  try {
    for (const [s, value] of [
      [a, 1],
      [b, 2],
    ] as const) {
      const lease = claim(s, "root");
      const result = submit(
        s,
        lease.id,
        Buffer.from(JSON.stringify({ value })),
        "Partition finding",
      );
      s.addEvent(
        makeEvent(m, key, {
          kind: "review",
          result: result.id,
          verdict: "approve",
          reason: "Independently reproduced in this partition",
        }),
      );
      expect(s.state()[0].status).toBe("accepted");
    }
    await sync(b, server.url.toString(), token);
    await sync(b, server.url.toString(), token);
    expect(a.state()[0].status).toBe("disputed");
    expect(b.state()[1].status).toBe("blocked");
    expect(digest(a.state())).toBe(digest(b.state()));
  } finally {
    server.stop(true);
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("seeded envelope corruption never changes a valid signature into accepted work", () => {
  const key = identity();
  const m: Manifest = {
    version: 1,
    name: "Fuzz",
    description: "Deterministic mutation corpus",
    validators: [key.publicKey],
    quorum: 1,
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
  const event = makeEvent(m, key, {
    kind: "claim",
    block: "x",
    expires: Date.now() + 10000,
    dependencies: [],
  });
  let rejected = 0;
  for (let n = 0; n < 1000; n++) {
    const altered = structuredClone(event);
    if (n % 3 === 0) altered.time += n + 1;
    else if (n % 3 === 1) altered.nonce = "corrupt-" + n;
    else altered.id = digest(n);
    try {
      validateEvent(altered, m);
    } catch {
      rejected++;
    }
  }
  expect(rejected).toBe(1000);
});
test("a process killed after committing recovers its SQLite WAL without graceful close", async () => {
  const { writeFileSync } = await import("node:fs");
  const path = mkdtempSync(join(tmpdir(), "bitswarm-crash-")),
    key = identity();
  const m: Manifest = {
    version: 1,
    name: "Crash",
    description: "Abrupt process death",
    validators: [key.publicKey],
    quorum: 1,
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
  writeFileSync(join(path, "manifest-input.json"), JSON.stringify(m));
  const code =
    'import{Store}from"' +
    process.cwd() +
    '/src/store.ts";import{readFileSync}from"node:fs";const s=new Store(process.argv[1],JSON.parse(readFileSync(process.argv[1]+"/manifest-input.json","utf8")));console.log(JSON.stringify({blob:s.addBlob(Buffer.from("committed before kill"))}));setInterval(()=>{},1000);';
  const child = Bun.spawn(["bun", "-e", code, path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const first = await child.stdout.getReader().read();
    expect(first.done).toBe(false);
    const record = JSON.parse(Buffer.from(first.value!).toString());
    child.kill("SIGKILL");
    await child.exited;
    const restored = new Store(path);
    expect(Buffer.from(restored.blob(record.blob)!).toString()).toBe(
      "committed before kill",
    );
    restored.close();
  } finally {
    child.kill("SIGKILL");
    rmSync(path, { recursive: true, force: true });
  }
});
