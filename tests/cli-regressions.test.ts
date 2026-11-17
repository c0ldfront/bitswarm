import { test, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { identity, makeEvent, digest, type Manifest } from "../src/core.ts";
import { claim, submit } from "../src/worker.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-cli-regression-"));
  const owner = identity();
  writeFileSync(join(dir, "identity.json"), JSON.stringify(owner));
  const manifest: Manifest = {
    version: 4,
    name: "Reading",
    description: "Check the CLI",
    validators: [owner.publicKey],
    quorum: 1,
    blocks: [
      {
        id: "page",
        title: "Page",
        instructions: "Read",
        requires: [],
        inputs: [],
        capabilities: [],
        contract: {
          timeoutMs: 60_000,
          maxAttempts: 3,
          maxTokens: 0,
          maxCostMicros: 0,
          verifier: "page",
        },
      },
    ],
  };
  const store = new Store(dir, manifest);
  return {
    dir,
    store,
    manifest,
    owner,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function cli(dir: string, ...args: string[]) {
  const run = Bun.spawnSync(["bun", "src/cli.ts", ...args, "--state", dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    output: run.stdout.toString(),
    error: run.stderr.toString(),
  };
}
test("manual claim honors the requested lease duration", () => {
  const f = setup();
  try {
    const res = cli(f.dir, "claim", "--block", "page", "--ttl", "3");
    expect(res.code).toBe(0);
    const claim = JSON.parse(res.output);
    expect(claim.payload.expires - claim.time).toBeGreaterThan(2900);
    expect(claim.payload.expires - claim.time).toBeLessThanOrEqual(3000);
  } finally {
    f.close();
  }
});
test("renew follows earlier renewals past the original expiration", () => {
  const f = setup();
  try {
    const now = Date.now();
    const initial = makeEvent(
      f.manifest,
      f.owner,
      {
        kind: "claim",
        block: "page",
        epoch: digest(f.manifest),
        expires: now - 1000,
        dependencies: [],
      },
      now - 5000,
    );
    f.store.addEvent(initial);
    f.store.addEvent(
      makeEvent(
        f.manifest,
        f.owner,
        { kind: "renew", claim: initial.id, expires: now + 10000 },
        now - 2000,
      ),
    );
    const res = cli(f.dir, "renew", "--claim", initial.id, "--ttl", "20");
    expect(res.error).toBe("");
    expect(JSON.parse(res.output).payload.expires).toBeGreaterThan(now + 15000);
  } finally {
    f.close();
  }
});
test("an invitation output collision leaves membership unchanged", () => {
  const f = setup(),
    key = identity().publicKey;
  try {
    const dest = join(f.dir, "invite.json");
    writeFileSync(dest, "existing");
    const res = cli(f.dir, "invite", "--publicKey", key, "--output", dest);
    expect(res.code).toBe(1);
    expect(readFileSync(dest, "utf8")).toBe("existing");
    expect(f.store.governance().members?.has(key)).toBe(false);
  } finally {
    f.close();
  }
});
for (const mode of ["work", "watch", "verify"] as const) {
  test(`interrupting ${mode} cleans up its process and preserves the attempt history`, async () => {
    const f = setup(),
      marker = join(f.dir, "started.json"),
      script = join(f.dir, "busy.ts");
    writeFileSync(
      script,
      `
      import { existsSync, renameSync, writeFileSync } from "node:fs";
      const marker = process.argv[2];
      writeFileSync(marker + ".tmp", JSON.stringify({pid: process.pid, cwd: process.cwd()}));
      renameSync(marker + ".tmp", marker);
      while (existsSync(marker)) await Bun.sleep(50);
    `,
    );
    const args = mode === "watch" ? ["work", "--watch"] : [mode];
    if (mode === "verify") {
      f.store.who = identity();
      const candidate = submit(
        f.store,
        claim(f.store, "page").id,
        Buffer.from("{}"),
        "Candidate",
      );
      args.push("--result", candidate.id, "--isolation", "process");
    }
    const signal = mode === "work" ? "SIGINT" : "SIGTERM";
    const cli = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        ...args,
        "--state",
        f.dir,
        "--",
        process.execPath,
        script,
        marker,
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const watchdog = setTimeout(() => cli.kill("SIGKILL"), 4000);
    try {
      const deadline = AbortSignal.timeout(3000);
      while (!existsSync(marker)) {
        deadline.throwIfAborted();
        if (cli.exitCode !== null)
          throw Error(await new Response(cli.stderr).text());
        await Bun.sleep(10);
      }
      const started = JSON.parse(readFileSync(marker, "utf8"));
      cli.kill(signal);
      await cli.exited;
      const events = f.store.events();
      expect(events.filter((e) => e.payload.kind === "claim")).toHaveLength(1);
      expect(events.filter((e) => e.payload.kind === "failure")).toHaveLength(
        mode === "verify" ? 0 : 1,
      );
      expect(events.filter((e) => e.payload.kind === "result")).toHaveLength(
        mode === "verify" ? 1 : 0,
      );
      expect(events.some((e) => e.payload.kind === "verification")).toBe(false);
      expect(existsSync(started.cwd)).toBe(false);
      expect(() => process.kill(started.pid, 0)).toThrow();
      expect(cli.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      expect(await new Response(cli.stderr).text()).toBe("");
    } finally {
      clearTimeout(watchdog);
      if (cli.exitCode === null) cli.kill("SIGKILL");
      await cli.exited;
      f.close();
    }
  });
}
test("an idle watched worker stops during its poll delay", async () => {
  const f = setup();
  f.store.configure({ download: "metadata", upload: "results" });
  const child = Bun.spawn(
    [
      process.execPath,
      "src/cli.ts",
      "work",
      "--watch",
      "--state",
      f.dir,
      "--",
      "unused",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const reader = child.stdout.getReader();
  let watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"idle": true');
    clearTimeout(watchdog);
    watchdog = setTimeout(() => child.kill("SIGKILL"), 1500);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(f.store.events()).toHaveLength(0);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
    f.close();
  }
});
const isolationTest =
  process.env.BITSWARM_TEST_ISOLATION === "1" ? test : test.skip;
isolationTest(
  "the verify CLI runs its verifier inside the default Bubblewrap workspace",
  () => {
    const f = setup();
    try {
      f.store.who = identity();
      const lease = claim(f.store, "page"),
        result = submit(f.store, lease.id, Buffer.from("{}"), "Done");
      const script = join(f.dir, "check.ts");
      writeFileSync(
        script,
        'const passed=process.cwd()==="/work"; console.log(JSON.stringify({passed,checks:[{name:"workspace",passed}]}));',
      );
      const run = Bun.spawnSync(
        [
          "bun",
          "src/cli.ts",
          "verify",
          "--state",
          f.dir,
          "--result",
          result.id,
          "--",
          "bun",
          script,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(run.stderr.toString()).toBe("");
      expect(JSON.parse(run.stdout.toString()).payload.passed).toBe(true);
    } finally {
      f.close();
    }
  },
);
