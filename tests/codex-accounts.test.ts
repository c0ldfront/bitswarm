import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectCodexAccount } from "../src/codex-accounts.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-codex-accounts-"));
  const binary = join(dir, "codex"),
    root = join(dir, "accounts");
  writeFileSync(
    binary,
    `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
if (process.env.HOME !== home || process.cwd() !== home ||
    process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN ||
    process.env.BITSWARM_TOKEN || process.env.BITSWARM_CODEX_CONFIG_HOME) process.exit(11);
if (args[0] !== "login" || !args.includes('cli_auth_credentials_store="file"') ||
    !args.includes('forced_login_method="chatgpt"')) process.exit(12);
const cache = join(home, "auth.json");
if (args.includes("status")) {
  console.error("fixture-sensitive-status-output");
  process.exit(existsSync(cache) && !existsSync(join(home, "sign-in-failed")) ? 0 : 2);
}
writeFileSync(join(home, "login-args.json"), JSON.stringify(args));
if (!existsSync(join(home, "use-keyring"))) writeFileSync(cache, "fixture", {mode: 0o600});
`,
    { mode: 0o700 },
  );
  async function cli(...args: string[]) {
    const child = Bun.spawn(
      [process.execPath, resolve("examples/codex-accounts.ts"), ...args],
      {
        env: {
          ...process.env,
          BITSWARM_CODEX_BINARY: binary,
          BITSWARM_CODEX_ACCOUNTS_DIR: root,
          CODEX_HOME: dir,
          OPENAI_API_KEY: "fixture",
          CODEX_API_KEY: "fixture",
          CODEX_ACCESS_TOKEN: "fixture",
          BITSWARM_TOKEN: "fixture",
          BITSWARM_CODEX_CONFIG_HOME: dir,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  return {
    root,
    dir,
    cli,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("account commands require explicit opt-in and valid local names before creating anything", async () => {
  const f = fixture();
  try {
    for (const action of ["login", "status"]) {
      const missing = await f.cli(action, "--account", "one");
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("--experimental");
      const escape = await f.cli(
        action,
        "--experimental",
        "--account",
        "../two",
      );
      expect(escape.code).toBe(1);
      expect(escape.stderr).toContain("Invalid Codex account label");
    }
    expect(() => selectCodexAccount("one", false)).toThrow("--experimental");
    expect(existsSync(f.root)).toBe(false);
  } finally {
    f.close();
  }
});

test("three profiles sign in separately and return the native status without exposing its output", async () => {
  const f = fixture();
  try {
    await Promise.all(
      ["one", "two", "three"].map(async (name) => {
        const flags = ["--account", name, "--experimental"];
        const authArgs = name === "three" ? ["--device-auth"] : [];
        const home = join(f.root, name);
        expect((await f.cli("login", ...flags, ...authArgs)).code).toBe(0);
        expect(statSync(home).mode & 0o777).toBe(0o700);
        expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
        const args = JSON.parse(
          readFileSync(join(home, "login-args.json"), "utf8"),
        );
        expect(args.includes("--device-auth")).toBe(name === "three");
        const state = await f.cli("status", ...flags);
        expect(state.code).toBe(0);
        expect(state.stderr).toBe("");
        expect(state.stdout).toContain("sign-in is stored");
      }),
    );
    expect(statSync(f.root).mode & 0o777).toBe(0o700);
    writeFileSync(join(f.root, "two", "sign-in-failed"), "");
    const failed = await f.cli("status", "--experimental", "--account", "two");
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain("Run login");
    expect(failed.stderr).not.toContain("fixture-sensitive-status-output");
    expect(
      (await f.cli("status", "--experimental", "--account", "one")).code,
    ).toBe(0);
  } finally {
    f.close();
  }
});

test("an uninitialized, shared or linked profile cannot fall back to the ambient account", async () => {
  const f = fixture();
  const flags = ["--experimental", "--account", "one"];
  try {
    writeFileSync(join(f.dir, "auth.json"), "ambient-fixture", { mode: 0o600 });
    expect((await f.cli("status", ...flags)).code).toBe(1);
    expect(existsSync(f.root)).toBe(false);
    const home = join(f.root, "one");
    mkdirSync(home, { mode: 0o700, recursive: true });
    writeFileSync(join(home, "use-keyring"), "");
    const login = await f.cli("login", ...flags);
    expect(login.code).toBe(1);
    expect(login.stderr).toContain("file credential store is missing");
    const cache = join(home, "auth.json");
    symlinkSync(join(f.dir, "auth.json"), cache);
    expect((await f.cli("login", ...flags)).stderr).toContain(
      "owner-only credential file",
    );
    rmSync(cache);
    writeFileSync(cache, "fixture");
    chmodSync(cache, 0o644);
    expect((await f.cli("status", ...flags)).stderr).toContain(
      "owner-only credential file",
    );
    chmodSync(f.root, 0o755);
    expect((await f.cli("status", ...flags)).stderr).toContain(
      "directories must be private",
    );
    expect(readFileSync(join(f.dir, "auth.json"), "utf8")).toBe(
      "ambient-fixture",
    );
  } finally {
    f.close();
  }
});
