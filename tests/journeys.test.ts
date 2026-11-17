import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { serve } from "../src/network.ts";
import { startMesh } from "../src/mesh.ts";
import { digest } from "../src/core.ts";
import { formatSwarmLink } from "../src/link.ts";
async function cli(args: string[], env: Record<string, string> = {}) {
  const process = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw new Error(`${args[0]}: ${error}`);
  return output.trim();
}
test("project owner and invited contributor complete the CLI lifecycle and reopen persisted state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-journey-"));
  const ownerPath = join(dir, "owner"),
    workerPath = join(dir, "worker");
  let owner: Store | undefined, server: ReturnType<typeof serve> | undefined;
  try {
    const manifest = JSON.parse(
      readFileSync("examples/reverse-engineering.json", "utf8"),
    );
    manifest.policy = { admission: "invite" };
    const source = join(dir, "manifest.json");
    writeFileSync(source, JSON.stringify(manifest));
    await cli(["init", "--state", ownerPath, "--manifest", source]);
    const key = JSON.parse(await cli(["keygen", "--state", workerPath]));
    const invitation = join(dir, "invitation.json");
    await cli([
      "invite",
      "--state",
      ownerPath,
      "--publicKey",
      key.publicKey,
      "--output",
      invitation,
    ]);
    owner = new Store(ownerPath);
    server = serve(owner, "", 0);
    const link = await cli([
      "share",
      "--state",
      ownerPath,
      "--peer",
      server.url.toString(),
    ]);
    await cli(["join", link, "--state", workerPath, "--invite", invitation]);
    const block = join(dir, "block.json");
    writeFileSync(
      block,
      JSON.stringify({
        id: "discovered",
        title: "Discovered task",
        instructions: "Inspect a newly discovered subsystem",
        requires: [],
        inputs: [],
        capabilities: [],
      }),
    );
    const proposal = JSON.parse(
      await cli([
        "propose",
        "--state",
        workerPath,
        "--file",
        block,
        "--reason",
        "Runtime discovery",
      ]),
    );
    await cli(["sync", "--state", workerPath, "--peer", server.url.toString()]);
    await cli(["admit", "--state", ownerPath, "--proposal", proposal.id]);
    await cli(["cancel", "--state", ownerPath, "--block", "discovered"]);
    await cli(["retry", "--state", ownerPath, "--block", "discovered"]);
    const policy = join(dir, "policy.json");
    writeFileSync(policy, JSON.stringify({ maxConcurrent: 2 }));
    await cli(["policy", "--state", ownerPath, "--file", policy]);
    await cli(["sync", "--state", workerPath, "--peer", server.url.toString()]);
    const lease = JSON.parse(
      await cli(["claim", "--state", workerPath, "--block", "discovered"]),
    );
    await cli([
      "renew",
      "--state",
      workerPath,
      "--claim",
      lease.id,
      "--ttl",
      "120",
    ]);
    const artifact = join(dir, "finding.json");
    writeFileSync(artifact, '{"observed":"fixture"}');
    const result = JSON.parse(
      await cli([
        "submit",
        "--state",
        workerPath,
        "--claim",
        lease.id,
        "--file",
        artifact,
        "--summary",
        "Observed fixture",
      ]),
    );
    await cli(["sync", "--state", workerPath, "--peer", server.url.toString()]);
    await cli([
      "review",
      "--state",
      ownerPath,
      "--result",
      result.id,
      "--verdict",
      "approve",
      "--reason",
      "Independently checked",
    ]);
    await cli(["checkpoint", "--state", ownerPath]);
    await cli(["sync", "--state", workerPath, "--peer", server.url.toString()]);
    const status = JSON.parse(await cli(["status", "--state", workerPath]));
    expect(status.blocks.find((b: any) => b.id === "discovered").status).toBe(
      "accepted",
    );
    expect(
      JSON.parse(await cli(["scoreboard", "--state", workerPath]))[0]
        .acceptedBlocks,
    ).toBe(1);
    const blob = join(dir, "input.txt");
    writeFileSync(blob, "seeded file");
    const put = JSON.parse(
      await cli(["put", "--state", workerPath, "--file", blob]),
    );
    const restored = join(dir, "restored.txt");
    await cli([
      "restore",
      "--state",
      workerPath,
      "--hash",
      put.root,
      "--output",
      restored,
    ]);
    expect(readFileSync(restored, "utf8")).toBe("seeded file");
    await cli(["unpin", "--state", workerPath, "--hash", put.root]);
    await cli(["pin", "--state", workerPath, "--hash", put.root]);
    await cli(["gc", "--state", workerPath]);
    expect(
      JSON.parse(await cli(["metrics", "--state", workerPath])).events,
    ).toBeGreaterThan(0);
    await cli(["install-handler", "--output", join(dir, "desktop")]);
    expect(
      readFileSync(join(dir, "desktop", "bitswarm.desktop"), "utf8"),
    ).toContain("x-scheme-handler/swarm");
    await cli(["revoke", "--state", ownerPath, "--publicKey", key.publicKey]);
    const rejected = Bun.spawn(
      [
        "bun",
        "src/cli.ts",
        "sync",
        "--state",
        workerPath,
        "--peer",
        server.url.toString(),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await rejected.exited).toBe(1);
  } finally {
    server?.stop(true);
    owner?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
test("a copied libp2p swarm link joins through the real CLI without an HTTP server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-mesh-cli-"));
  let store: Store | undefined,
    mesh: Awaited<ReturnType<typeof startMesh>> | undefined;
  const token = crypto.randomUUID();
  try {
    const path = join(dir, "seed");
    await cli([
      "init",
      "--state",
      path,
      "--manifest",
      "examples/reverse-engineering.json",
    ]);
    store = new Store(path);
    mesh = await startMesh(store, token);
    const uri = formatSwarmLink({
      swarm: digest(store.manifest),
      peers: mesh.addresses(),
    });
    let joined: any;
    try {
      joined = JSON.parse(
        await cli(["join", uri, "--state", join(dir, "joined")], {
          BITSWARM_TOKEN: token,
        }),
      );
    } catch (e) {
      throw new Error(
        String(e) + " SERVER " + JSON.stringify(store.metrics().quarantine),
      );
    }
    expect(joined.swarm).toBe(digest(store.manifest));
  } finally {
    await mesh?.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("automation dials a mesh peer listed only in its operator config", async () => {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-run-mesh-"));
  let seed: Store | undefined,
    mesh: Awaited<ReturnType<typeof startMesh>> | undefined;
  const token = crypto.randomUUID();
  try {
    const owner = join(path, "seed"),
      worker = join(path, "worker");
    await cli([
      "init",
      "--state",
      owner,
      "--manifest",
      "examples/reverse-engineering.json",
    ]);
    seed = new Store(owner);
    const local = new Store(worker, seed.manifest);
    local.close();
    for (const block of seed.manifest.blocks)
      await cli(["cancel", "--state", owner, "--block", block.id]);
    mesh = await startMesh(seed, token);
    const config = join(path, "run.json");
    writeFileSync(
      config,
      JSON.stringify({
        peers: mesh.addresses(),
        pollMs: 100,
        deadlineMs: 3500,
        stopWhenComplete: true,
      }),
    );
    await cli(["run", "--state", worker, "--config", config], {
      BITSWARM_TOKEN: token,
    });
    const state = JSON.parse(await cli(["status", "--state", worker]));
    expect(
      state.blocks.every((b: { status: string }) => b.status === "cancelled"),
    ).toBe(true);
  } finally {
    await mesh?.stop();
    seed?.close();
    rmSync(path, { recursive: true, force: true });
  }
}, 15000);
