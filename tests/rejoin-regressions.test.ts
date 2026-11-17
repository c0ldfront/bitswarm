import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grant } from "../src/access.ts";
import { control } from "../src/control.ts";
import { digest, identity, type Manifest } from "../src/core.ts";
import { formatSwarmLink } from "../src/link.ts";
import { startMesh } from "../src/mesh.ts";
import { handle, serve } from "../src/network.ts";
import { Store } from "../src/store.ts";

function project(validator: string): Manifest {
  return {
    version: 4,
    name: "Rejoin fixture",
    description: "Exercise bootstrap and saved invitations.",
    validators: [validator],
    quorum: 1,
    blocks: [
      {
        id: "a",
        title: "A",
        instructions: "Read",
        requires: [],
        inputs: [],
        capabilities: [],
      },
    ],
  };
}

async function cli(args: string[], token = "") {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, BITSWARM_TOKEN: token },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return JSON.parse(out);
}

test("join and preview reuse peers only from a state pinned to the requested swarm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-rejoin-"));
  const source = new Store(join(dir, "source"), project(identity().publicKey));
  const token = crypto.randomUUID();
  const server = serve(source, token, 0);
  try {
    const state = join(dir, "worker"),
      swarm = digest(source.manifest);
    const uri = formatSwarmLink({ swarm, peers: [] });
    await cli(
      ["join", uri, "--state", state, "--peer", server.url.origin],
      token,
    );
    expect((await cli(["preview", uri, "--state", state], token)).peer).toBe(
      server.url.origin,
    );
    expect((await cli(["join", uri, "--state", state], token)).peer).toBe(
      server.url.origin,
    );
    const unrelated = formatSwarmLink({ swarm: "f".repeat(64), peers: [] });
    await expect(
      cli(["preview", unrelated, "--state", state], token),
    ).rejects.toThrow("No bootstrap hints");
  } finally {
    server.stop(true);
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale HTTP link hint falls back to an explicitly supplied mesh bootstrap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-bootstrap-"));
  const source = new Store(join(dir, "source"), project(identity().publicKey));
  const token = crypto.randomUUID();
  let mesh: Awaited<ReturnType<typeof startMesh>> | undefined;
  const stale = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  try {
    mesh = await startMesh(source, token);
    const uri = formatSwarmLink({
      swarm: digest(source.manifest),
      peers: [stale.url.origin],
    });
    const peer = mesh.addresses()[0];
    const result = await cli(
      [
        "join",
        uri,
        "--state",
        join(dir, "worker"),
        "--bootstrap",
        peer.slice("libp2p:".length),
      ],
      token,
    );
    expect(result.peer).toBe(peer);
  } finally {
    await mesh?.stop();
    stale.stop(true);
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test("a failed rejoin leaves the last working invitation available", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-invite-rejoin-"));
  const owner = identity(),
    worker = identity();
  const seed = join(dir, "seed"),
    state = join(dir, "worker");
  for (const [path, key] of [
    [seed, owner],
    [state, worker],
  ] as const) {
    mkdirSync(path);
    writeFileSync(join(path, "identity.json"), JSON.stringify(key));
  }
  const source = new Store(seed, {
    ...project(owner.publicKey),
    policy: { admission: "invite" },
  });
  let available = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (!available && new URL(req.url).pathname === "/v1/inventory")
        return new Response(null, { status: 503 });
      return handle(source, "", req);
    },
  });
  try {
    const uri = formatSwarmLink({
      swarm: digest(source.manifest),
      peers: [server.url.origin],
    });
    const ticket = join(dir, "ticket.json"),
      saved = join(state, "access.json");
    const makeTicket = () =>
      grant(source, worker.publicKey, "worker", Date.now() + 60_000);
    const initial = makeTicket(),
      replacement = makeTicket();
    control(source, {
      type: "member",
      key: worker.publicKey,
      enabled: true,
      role: "worker",
    });
    writeFileSync(ticket, JSON.stringify(initial));
    await cli(["join", uri, "--state", state, "--invite", ticket]);
    writeFileSync(ticket, JSON.stringify(replacement));
    available = false;
    await expect(
      cli(["join", uri, "--state", state, "--invite", ticket]),
    ).rejects.toThrow("503");
    expect(JSON.parse(readFileSync(saved, "utf8"))).toEqual(initial);
    available = true;
    await cli(["join", uri, "--state", state, "--invite", ticket]);
    expect(JSON.parse(readFileSync(saved, "utf8"))).toEqual(replacement);
  } finally {
    server.stop(true);
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
