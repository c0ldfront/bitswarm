import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { serve } from "../src/network.ts";
import { digest } from "../src/core.ts";
import { parseSwarmLink, formatSwarmLink } from "../src/link.ts";

const token = "cli-end-to-end-secret-at-least-32-characters";
async function cli(...args: string[]) {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, BITSWARM_TOKEN: token },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`CLI ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}
test("CLI creates and shares a swarm, joins with fallback, works, reviews and exports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-cli-"));
  const seedPath = join(dir, "seed"),
    workerPath = join(dir, "worker");
  let seed: Store | undefined, wrong: Store | undefined;
  let server: ReturnType<typeof serve> | undefined,
    wrongServer: ReturnType<typeof serve> | undefined;
  try {
    const created = JSON.parse(
      await cli(
        "init",
        "--state",
        seedPath,
        "--manifest",
        "examples/reverse-engineering.json",
        "--input",
        "examples/adapter.ts",
      ),
    );
    seed = new Store(seedPath);
    server = serve(seed, token, 0);
    const uri = await cli(
      "share",
      "--state",
      seedPath,
      "--peer",
      server.url.toString(),
    );
    expect(parseSwarmLink(uri).swarm).toBe(created.swarm);
    wrong = new Store(join(dir, "wrong"), {
      ...seed.manifest,
      name: "Another project",
    });
    wrongServer = serve(wrong, token, 0);
    const withFallback = formatSwarmLink({
      ...parseSwarmLink(uri),
      peers: [wrongServer.url.toString(), server.url.toString()],
    });
    const joined = JSON.parse(
      await cli("join", withFallback, "--state", workerPath),
    );
    expect(joined.swarm).toBe(created.swarm);
    expect(joined.peer).toBe(server.url.origin);
    const work = JSON.parse(
      await cli(
        "work",
        "--state",
        workerPath,
        "--capability",
        "static-analysis",
        "--",
        "bun",
        "examples/adapter.ts",
      ),
    );
    await cli("sync", "--state", workerPath, "--peer", server.url.toString());
    const inspected = JSON.parse(
      await cli("inspect", "--state", seedPath, "--result", work.submitted),
    );
    expect(JSON.parse(inspected.artifact.data).kind).toBe(
      "fixture-observation",
    );
    await cli(
      "review",
      "--state",
      seedPath,
      "--result",
      work.submitted,
      "--verdict",
      "approve",
      "--reason",
      "Reproduced fixture observations",
    );
    await cli("sync", "--state", workerPath, "--peer", server.url.toString());
    const status = JSON.parse(await cli("status", "--state", workerPath));
    expect(status.blocks[0].status).toBe("accepted");
    expect(status.blocks[1].status).toBe("ready");
    const output = join(dir, "report.json");
    await cli("export", "--state", workerPath, "--output", output);
    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report.swarm).toBe(digest(seed.manifest));
    expect(report.blocks[0].reviews).toHaveLength(1);
    // A mismatched pinned identity must not initialize a worker state.
    const child = Bun.spawn(
      [
        "bun",
        "src/cli.ts",
        "join",
        "--state",
        join(dir, "bad"),
        "--peer",
        server.url.toString(),
        "--swarm",
        digest("wrong"),
      ],
      {
        env: { ...process.env, BITSWARM_TOKEN: token },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    expect(await child.exited).toBe(1);
  } finally {
    server?.stop(true);
    wrongServer?.stop(true);
    seed?.close();
    wrong?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
