import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import {
  identity,
  hash,
  digest,
  type Manifest,
  makeEvent,
} from "../src/core.ts";
import { serve, sync, request } from "../src/network.ts";
import { grant } from "../src/access.ts";
import { control } from "../src/control.ts";
import { runWorker } from "../src/worker.ts";
import { formatSwarmLink } from "../src/link.ts";
const planner = identity(),
  token = "participation-test-token-aaaaaaaaaaaaaaa";
const first = Buffer.from("first input"),
  second = Buffer.from("second input"),
  extra = Buffer.from("optional table");
function manifest(restricted = false): Manifest {
  return {
    version: 4,
    name: "Image workshop",
    description: "Private project goal",
    planner: planner.publicKey,
    validators: [planner.publicKey],
    quorum: 1,
    ...(restricted
      ? {
          restricted: true,
          preview: "Invited workshop",
          policy: { admission: "invite" as const },
        }
      : {}),
    blocks: [first, second].map((bytes, i) => ({
      id: "task" + i,
      title: "Component " + i,
      instructions: "Return findings",
      requires: [],
      inputs: [hash(bytes)],
      optionalInputs: i ? [] : [hash(extra)],
      capabilities: ["cap" + i],
      contract: {
        maxTokens: 100,
        maxCostMicros: 0,
        maxAttempts: 2,
        timeoutMs: 8000,
      },
    })),
  };
}
async function cli(args: string[], secret = token) {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, BITSWARM_TOKEN: secret },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status) throw Error(err);
  return JSON.parse(out);
}
test("preview and join fetch zero payload, claim fetches one input, duplex and caps survive switches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-participant-")),
    owner = new Store(join(dir, "seed"), manifest()),
    state = join(dir, "peer");
  const server = serve(owner, token, 0);
  let peer: Store | undefined;
  try {
    for (const data of [first, second, extra]) owner.addBlob(data);
    const uri = formatSwarmLink({
      swarm: digest(owner.manifest),
      peers: [server.url.origin],
    });
    const preview = await cli(["preview", uri, "--state", state]);
    expect(preview.tasks[0].declaredInputBytes).toBe(first.length);
    expect(existsSync(join(state, "manifest.json"))).toBe(false);
    await cli(["join", uri, "--state", state]);
    peer = new Store(state);
    expect(peer.inventory().blobs).toEqual([]);
    await cli(["claim", "--state", state, "--block", "task0"]);
    expect(peer.inventory().blobs).toEqual([hash(first)]);
    const listener = serve(peer, token, 0);
    try {
      await expect(
        request(listener.url.origin, token, "/v1/blobs/" + hash(first)),
      ).rejects.toThrow();
      await cli([
        "participation",
        "--state",
        state,
        "--upload",
        "cache",
        "--uploadBytes",
        String(first.length),
      ]);
      expect(
        Buffer.from(
          await request(listener.url.origin, token, "/v1/blobs/" + hash(first)),
        ),
      ).toEqual(first);
      await expect(
        request(listener.url.origin, token, "/v1/blobs/" + hash(first)),
      ).rejects.toThrow("limit");
      await cli(["participation", "--state", state, "--download", "metadata"]);
      await expect(
        request(listener.url.origin, token, "/v1/blobs/" + hash(second), {
          method: "PUT",
          body: second,
        }),
      ).rejects.toThrow("selection");
      await cli([
        "participation",
        "--state",
        state,
        "--download",
        "mirror",
        "--downloadBytes",
        String(first.length),
      ]);
      await sync(peer, server.url.origin, token);
      expect(peer.hasBlob(hash(second))).toBe(false);
      await cli(["participation", "--state", state, "--downloadBytes", "200"]);
      await sync(peer, server.url.origin, token);
      expect(peer.hasBlob(hash(second))).toBe(true);
    } finally {
      listener.stop(true);
    }
  } finally {
    server.stop(true);
    peer?.close();
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
test("restricted invitations limit raw GET, inventory, chunks and relays; guessed hashes stay unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-grant-")),
    m = manifest(true),
    worker = identity();
  const chunk = Buffer.from("pixels"),
    index = Buffer.from(
      JSON.stringify({ type: "bitswarm.file.v1", chunks: [hash(chunk)] }),
    );
  m.blocks[0].inputs = [hash(index)];
  const seed = new Store(join(dir, "seed"), m),
    replica = new Store(join(dir, "replica"), m);
  seed.who = planner;
  const server = serve(seed, "", 0),
    other = serve(replica, "", 0);
  try {
    for (const bytes of [chunk, index, second]) seed.addBlob(bytes);
    const adm = control(seed, {
      type: "member",
      enabled: true,
      key: worker.publicKey,
      role: "worker",
    });
    replica.addEvent(adm);
    const ticket = grant(seed, worker.publicKey, "worker", Date.now() + 60000, {
      blocks: ["task0"],
      roots: [],
    });
    const auth = { identity: worker, grant: ticket };
    const uri = formatSwarmLink({
      swarm: digest(m),
      peers: [server.url.origin],
    });
    expect(
      (await cli(["preview", uri, "--state", join(dir, "guest")], ""))
        .advertisedSummary,
    ).toBe("Invited workshop");
    for (const s of [seed, replica]) {
      const peer = s === seed ? server : other;
      if (s === replica)
        for (const data of [chunk, index, second]) replica.addBlob(data);
      expect(
        Buffer.from(
          await request(peer.url.origin, auth, "/v1/blobs/" + hash(chunk)),
        ),
      ).toEqual(chunk);
      await expect(
        request(peer.url.origin, auth, "/v1/blobs/" + hash(second)),
      ).rejects.toThrow("404");
      const inv = JSON.parse(
        Buffer.from(
          await request(peer.url.origin, auth, "/v1/inventory?type=blobs"),
        ).toString(),
      );
      expect(inv.ids).not.toContain(hash(second));
      await expect(
        request(peer.url.origin, auth, "/v1/blobs/" + hash(second), {
          method: "PUT",
          body: second,
        }),
      ).rejects.toThrow("pull");
    }
    await expect(
      request(server.url.origin, token, "/v1/manifest"),
    ).rejects.toThrow("401");
    control(seed, {
      type: "member",
      enabled: false,
      key: worker.publicKey,
      role: "worker",
    });
    await expect(
      request(server.url.origin, auth, "/v1/blobs/" + hash(chunk)),
    ).rejects.toThrow("revoked");
  } finally {
    server.stop(true);
    other.stop(true);
    seed.close();
    replica.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("adapter requests one declared optional input and reports both turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-optional-")),
    seed = new Store(join(dir, "seed"), manifest()),
    w = new Store(join(dir, "worker"), seed.manifest);
  const server = serve(seed, token, 0),
    previous = process.env.BITSWARM_TOKEN;
  try {
    process.env.BITSWARM_TOKEN = token;
    for (const data of [first, second, extra]) seed.addBlob(data);
    w.configure({ download: "tasks", upload: "results" });
    w.rememberPeer(server.url.origin);
    const script =
      'const i=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify(i.sources.length===1?{needInput:{root:i.block.optionalInputs[0],reason:"Need color table"},usage:{tokens:2,costMicros:0}}:{artifact:{sources:i.sources.length,remaining:i.block.contract.maxTokens},summary:"decoded",usage:{tokens:3,costMicros:0}}))';
    const e = await runWorker(w, ["bun", "-e", script], ["cap0"]);
    expect(e?.payload.kind).toBe("result");
    if (e?.payload.kind === "result") {
      expect(e.payload.usage?.tokens).toBe(5);
      expect(
        JSON.parse(Buffer.from(w.blob(e.payload.artifact)!).toString()),
      ).toEqual({ sources: 2, remaining: 98 });
    }
    expect(w.hasBlob(hash(second))).toBe(false);
    expect(w.events().some((e) => e.payload.kind === "input-request")).toBe(
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = previous;
    server.stop(true);
    seed.close();
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
