import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { identity, validateEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";

const adapter = resolve(import.meta.dir, "../examples/codex-adapter.ts");
const cli = resolve(import.meta.dir, "../src/cli.ts");

test("three concurrent worker CLIs route to separate Codex accounts and publish only their task results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-codex-workers-"));
  const accounts = join(dir, "accounts"),
    state = join(dir, "state"),
    probes = join(dir, "probes");
  const labels = ["private-red", "private-green", "private-blue"];
  const blocks = ["square", "circle", "triangle"];
  const marker = "fixture-private-credential";
  const binary = join(dir, "fake-codex");
  let store: Store | undefined;
  try {
    mkdirSync(accounts, { mode: 0o700 });
    mkdirSync(probes);
    for (const label of labels) {
      mkdirSync(join(accounts, label), { mode: 0o700 });
      writeFileSync(
        join(accounts, label, "auth.json"),
        JSON.stringify({ fixture: marker }),
        { mode: 0o600 },
      );
    }
    const manifest: Manifest = {
      version: 4,
      name: "Geometry",
      description: "Collect one observation per shape",
      validators: [identity().publicKey],
      quorum: 1,
      blocks: blocks.map((id) => ({
        id,
        title: id,
        instructions: "Identify the shape",
        requires: [],
        capabilities: [id],
        inputs: [],
      })),
    };
    store = new Store(state, manifest);
    writeFileSync(
      binary,
      `#!${process.execPath}
import { join } from "node:path";
import { readdirSync, writeFileSync } from "node:fs";
const { packet } = JSON.parse(await Bun.stdin.text());
const block = packet.block.id;
if (!${JSON.stringify(blocks)}.includes(block)) process.exit(1);
const probes = ${JSON.stringify(probes)};
writeFileSync(join(probes, block), JSON.stringify({
  codexHome: process.env.CODEX_HOME,
  ambientAuth: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "BITSWARM_TOKEN"].filter(key => process.env[key] !== undefined),
  packet,
}));
const deadline = Date.now() + 4000;
while (readdirSync(probes).length < 3) {
  if (Date.now() >= deadline) throw Error("Concurrent workers did not start");
  await Bun.sleep(10);
}
const out = process.argv[process.argv.indexOf("--output-last-message") + 1];
writeFileSync(out, JSON.stringify({summary: "Inspected shape", artifact_json: JSON.stringify({shape: block})}));
console.log(JSON.stringify({type: "turn.completed", usage: {input_tokens: 3, output_tokens: 1}}));
`,
      { mode: 0o700 },
    );
    const children = blocks.map((id, i) =>
      Bun.spawn(
        [
          process.execPath,
          cli,
          "work",
          "--state",
          state,
          "--capability",
          id,
          "--ttl",
          "10",
          "--",
          process.execPath,
          adapter,
          "--experimental",
          "--account",
          labels[i],
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            CODEX_HOME: join(dir, "default-codex"),
            OPENAI_API_KEY: marker,
            CODEX_API_KEY: marker,
            CODEX_ACCESS_TOKEN: marker,
            BITSWARM_TOKEN: marker.padEnd(32, "-"),
            BITSWARM_CODEX_BINARY: binary,
            BITSWARM_CODEX_ACCOUNTS_DIR: accounts,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    const runs = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        output: await new Response(child.stdout).text(),
        errors: await new Response(child.stderr).text(),
      })),
    );
    const events = store.events();
    for (const e of events) validateEvent(e, manifest);
    const visible = [
      JSON.stringify(events),
      ...store
        .inventory()
        .blobs.map((id) => Buffer.from(store!.blob(id)!).toString()),
    ];
    for (const [i, run] of runs.entries()) {
      expect(run.errors).toBe("");
      expect(run.code).toBe(0);
      const published = JSON.parse(run.output);
      expect(published.block).toBe(blocks[i]);
      const event = store.event(published.submitted);
      if (event?.payload.kind !== "result")
        throw Error("Expected signed result");
      expect(event.author).toBe(store.who.publicKey);
      expect(event.payload.usage).toEqual({ tokens: 4, costMicros: 0 });
      const artifact = JSON.parse(
        Buffer.from(store.blob(event.payload.artifact)!).toString(),
      );
      expect(artifact.shape).toBe(blocks[i]);
      const probe = JSON.parse(readFileSync(join(probes, blocks[i]), "utf8"));
      expect(probe.codexHome).toBe(join(accounts, labels[i]));
      expect(probe.ambientAuth).toEqual([]);
      visible.push(JSON.stringify(probe.packet));
    }
    expect(events.filter((e) => e.payload.kind === "result")).toHaveLength(3);
    const publicData = visible.join("\n");
    for (const privateValue of [dir, ...labels, marker])
      expect(publicData).not.toContain(privateValue);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("the Codex adapter CLI requires opt-in before selecting an account", () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-adapter-opt-in-"));
  try {
    const run = Bun.spawnSync(
      [process.execPath, adapter, "--account", "private-red"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          CODEX_HOME: dir,
          BITSWARM_CODEX_BINARY: join(dir, "unused"),
        },
        stdin: Buffer.from("{}"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(
      "Named Codex accounts require --experimental",
    );
    expect(run.stdout.toString()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
