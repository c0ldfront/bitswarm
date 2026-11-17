import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { serve } from "../src/network.ts";
import { identity, type Manifest } from "../src/core.ts";
import { formatSwarmLink } from "../src/link.ts";
async function cli(args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, BITSWARM_TOKEN: "", ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw Error(err);
  return out.trim();
}
test("public swarm links join without shared credentials and encrypted CLI backups restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-cli-v3-")),
    key = identity();
  const m: Manifest = {
    version: 3,
    name: "Public CLI",
    description: "User-facing public invitation and recovery",
    validators: [key.publicKey],
    quorum: 1,
    policy: { admission: "public", publicWorkBits: 8 },
    credits: { difficulty: 8, reward: 10, confirmations: 0 },
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
  const source = new Store(join(dir, "source"), m);
  const server = serve(source, "", 0);
  try {
    const path = join(dir, "joined");
    const uri = formatSwarmLink({
      swarm: source.inventory().swarm,
      peers: [server.url.toString()],
    });
    const joined = JSON.parse(await cli(["join", uri, "--state", path]));
    expect(joined.swarm).toBe(source.inventory().swarm);
    const encrypted = join(dir, "backup");
    const env = {
      BITSWARM_BACKUP_PASSPHRASE: "synthetic-long-test-passphrase",
    };
    await cli(["backup", "--state", path, "--output", encrypted], env);
    await cli(
      ["restore-state", "--state", join(dir, "restored"), "--file", encrypted],
      env,
    );
    expect(
      JSON.parse(await cli(["status", "--state", join(dir, "restored")])).swarm,
    ).toBe(joined.swarm);
    expect(JSON.parse(await cli(["credits", "--state", path])).height).toBe(0);
    await cli(["mine", "--state", path]);
    expect(JSON.parse(await cli(["credits", "--state", path])).height).toBe(1);
  } finally {
    server.stop(true);
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("preview does not forward a saved private invitation when opening another swarm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-preview-context-"));
  const local = identity(),
    planner = identity();
  writeFileSync(join(dir, "identity.json"), JSON.stringify(local));
  const wrong = { subject: local.publicKey, swarm: "0".repeat(64) };
  const ticket = join(dir, "access.json");
  writeFileSync(ticket, JSON.stringify(wrong));
  const source = new Store(join(dir, "owner"), {
    version: 4,
    name: "Workshop",
    description: "Private detail",
    preview: "Published overview",
    restricted: true,
    validators: [planner.publicKey],
    quorum: 1,
    policy: { admission: "invite" },
    blocks: [
      {
        id: "a",
        title: "A",
        instructions: "Read",
        inputs: [],
        requires: [],
        capabilities: [],
      },
    ],
  });
  const server = serve(source, "", 0);
  try {
    const link = formatSwarmLink({
      swarm: source.inventory().swarm,
      peers: [server.url.origin],
    });
    expect(
      JSON.parse(await cli(["preview", link, "--state", dir]))
        .advertisedSummary,
    ).toBe("Published overview");
    await expect(
      cli(["preview", link, "--state", dir, "--invite", ticket]),
    ).rejects.toThrow("another swarm");
  } finally {
    server.stop(true);
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
