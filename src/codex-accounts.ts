import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { assert } from "./core.ts";

const config = [
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'forced_login_method="chatgpt"',
];

function accountHome(name: string, experimental: boolean, create: boolean) {
  assert(experimental === true, "Named Codex accounts require --experimental");
  assert(
    typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(name),
    "Invalid Codex account label",
  );
  const root =
    process.env.BITSWARM_CODEX_ACCOUNTS_DIR ??
    join(
      process.env.BITSWARM_CODEX_ACCOUNT_HOME || homedir(),
      ".local/share/bitswarm/codex-accounts",
    );
  assert(isAbsolute(root), "The Codex accounts directory must be absolute");
  const home = join(root, name);
  const uid = process.getuid?.();
  assert(
    uid !== undefined,
    "Named Codex accounts require POSIX file permissions",
  );
  try {
    for (const directory of [root, home]) {
      if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      assert(stat, "Sign in to this named Codex account first");
      assert(
        stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0,
        "Codex account directories must be private and owned by the current user",
      );
    }
    const credentials = lstatSync(join(home, "auth.json"), {
      throwIfNoEntry: false,
    });
    if (credentials) {
      assert(
        credentials.isFile() &&
          credentials.nlink === 1 &&
          credentials.uid === uid &&
          (credentials.mode & 0o077) === 0,
        "Codex requires a private, owner-only credential file for this account",
      );
    } else {
      assert(
        create,
        "The local file credential store is missing. Sign in to this named Codex account.",
      );
    }
  } catch (error) {
    // A worker may publish an error message with its failure receipt.
    if (error instanceof Error && "code" in error)
      throw Error("Cannot access the local Codex account directory");
    throw error;
  }
  return home;
}

export function selectCodexAccount(name: string, experimental: boolean) {
  return { home: accountHome(name, experimental, false), config: [...config] };
}

export async function manageCodexAccount(
  action: "login" | "status",
  name: string,
  experimental: boolean,
  deviceAuth = false,
) {
  assert(action === "login" || action === "status", "Expected login or status");
  assert(!deviceAuth || action === "login", "--device-auth applies to login");
  const login = action === "login";
  const home = accountHome(name, experimental, login);
  const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home };
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|TERM|BROWSER|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LANG|LC_\w+|TMPDIR|CODEX_CA_CERTIFICATE|SSL_CERT_FILE|SSL_CERT_DIR|(http|https|all|no)_proxy)$/i.test(
        key,
      )
    )
      env[key] = value;
  }

  const child = Bun.spawn(
    [
      process.env.BITSWARM_CODEX_BINARY || "codex",
      "login",
      ...config,
      ...(login ? (deviceAuth ? ["--device-auth"] : []) : ["status"]),
    ],
    {
      cwd: home,
      env,
      stdin: login ? "inherit" : "ignore",
      stdout: login ? "inherit" : "ignore",
      stderr: login ? "inherit" : "ignore",
    },
  );
  const interrupt = (signal: NodeJS.Signals) => child.kill(signal);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const code = await child.exited;
    if (code !== 0) {
      if (!login)
        console.error(
          "Codex could not confirm the named sign-in. Run login for this account.",
        );
      return code;
    }
    selectCodexAccount(name, experimental);
    console.log("Codex sign-in is stored for this account.");
    return 0;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
