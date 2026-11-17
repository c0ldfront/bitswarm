import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, basename, dirname } from "node:path";
import { restoreFile } from "./artifacts.ts";
import { assert, hash, isHash, MAX_BLOB } from "./core.ts";
import type { Store } from "./store.ts";
export type Isolation = "process" | "bwrap" | "docker";
export type Execution = {
  command: string[];
  input: unknown;
  timeoutMs: number;
  cwd?: string;
  isolation?: Isolation;
  image?: string;
  env?: Record<string, string>;
  maxOutput?: number;
  forwardProvider?: boolean;
  signal?: AbortSignal;
};
export class ExecutionError extends Error {
  constructor(
    message: string,
    public stderr: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}
export async function execute(
  o: Execution,
): Promise<{ stdout: string; durationMs: number }> {
  assert(o.command.length, "Missing executable");
  let command = [...o.command];
  const cwd = resolve(o.cwd || process.cwd());
  const mode = o.isolation || "process";
  const hostExecutable = mode === "docker" ? command[0] : Bun.which(command[0]);
  assert(hostExecutable, "Executable not found");
  if (mode !== "docker") command[0] = hostExecutable;
  const container =
    mode === "docker" ? "bitswarm-" + crypto.randomUUID() : undefined;
  if (mode !== "process")
    command = command.map((argument) =>
      argument === cwd
        ? "/work"
        : argument.startsWith(cwd + "/")
          ? "/work" + argument.slice(cwd.length)
          : argument,
    );
  if (mode === "bwrap") {
    // Explicitly mounted system runtime and workspace only. No network/home mounts.
    const executable = hostExecutable;
    command = [
      "bwrap",
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      cwd,
      "/work",
      "--chdir",
      "/work",
      "--clearenv",
      "--setenv",
      "PATH",
      dirname(hostExecutable) + ":/usr/bin:/bin",
      ...(executable.startsWith("/usr/") ||
      executable.startsWith("/bin/") ||
      executable.startsWith(cwd + "/")
        ? []
        : ["--ro-bind", executable, executable]),
      ...command,
    ];
  } else if (mode === "docker") {
    assert(
      o.image && /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(o.image),
      "Docker isolation requires a valid explicitly configured image",
    );
    command = [
      "docker",
      "run",
      "--rm",
      "--name",
      container!,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "1g",
      "--cpus",
      "2",
      "--user",
      `${process.getuid?.() ?? 65532}:${process.getgid?.() ?? 65532}`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=128m",
      "-i",
      "-v",
      `${cwd}:/work`,
      "-w",
      "/work",
      o.image,
      ...command,
    ];
  }
  const started = Date.now();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: cwd,
    TMPDIR: tmpdir(),
    ...o.env,
  };
  // Local adapters explicitly receive provider configuration, never the swarm token or private key.
  for (const [key, value] of Object.entries(process.env))
    if (
      o.forwardProvider &&
      /^(BITSWARM_LLM_|BITSWARM_CODEX_|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/.test(
        key,
      )
    )
      env[key] = value;
  if (o.forwardProvider) {
    env.BITSWARM_CODEX_ACCOUNT_HOME = process.env.HOME;
    env.BITSWARM_CODEX_CONFIG_HOME = process.env.CODEX_HOME;
  }
  o.signal?.throwIfAborted();
  return new Promise((done, fail) => {
    const ownsGroup = !process.env.BITSWARM_RUN_GROUP;
    if (o.forwardProvider) env.BITSWARM_RUN_GROUP = "1";
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      detached: ownsGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const diagnostic: Buffer[] = [];
    let size = 0,
      stderr = 0,
      finished = false;
    const descendants = new Map<number, string>();
    const identity = (pid: number) => {
      try {
        return readFileSync("/proc/" + pid + "/stat", "utf8")
          .split(") ")
          .at(-1)!
          .split(" ")[19];
      } catch {
        return undefined;
      }
    };
    const collect = (pid: number, depth = 0) => {
      if (depth > 16 || descendants.size > 1000) return;
      try {
        for (const text of readFileSync(
          "/proc/" + pid + "/task/" + pid + "/children",
          "utf8",
        )
          .trim()
          .split(" ")) {
          const child = Number(text);
          if (!child) continue;
          const born = identity(child);
          if (born) {
            descendants.set(child, born);
            collect(child, depth + 1);
          }
        }
      } catch {}
    };
    const childrenTimer = setInterval(() => {
      if (child.pid) collect(child.pid);
    }, 50);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(childrenTimer);
      if (child.pid) collect(child.pid);
      for (const [pid, born] of descendants)
        if (identity(pid) === born)
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
      o.signal?.removeEventListener("abort", abort);
      try {
        if (child.pid) {
          if (ownsGroup) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
      const settle = () =>
        error
          ? fail(
              new ExecutionError(
                error.message,
                Buffer.concat(diagnostic).toString(),
              ),
            )
          : done({
              stdout: Buffer.concat(chunks).toString(),
              durationMs: Date.now() - started,
            });
      if (container) {
        const cleanup = spawn("docker", ["rm", "-f", container], {
          env: { PATH: process.env.PATH },
          stdio: "ignore",
        });
        const timer = setTimeout(() => {
          cleanup.kill("SIGKILL");
        }, 10_000);
        cleanup.once("close", () => {
          clearTimeout(timer);
          settle();
        });
        cleanup.once("error", () => {
          clearTimeout(timer);
          settle();
        });
      } else settle();
    };
    const abort = () => finish(new Error("Execution cancelled"));
    o.signal?.addEventListener("abort", abort, { once: true });
    if (o.signal?.aborted) queueMicrotask(abort);
    const timer = setTimeout(
      () => finish(new Error("Executable timed out")),
      o.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (o.maxOutput || MAX_BLOB))
        finish(new Error("Executable output limit exceeded"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr <= 65536) diagnostic.push(chunk);
      if (stderr > (o.maxOutput || MAX_BLOB))
        finish(new Error("Executable stderr limit exceeded"));
    });
    child.once("error", () => finish(new Error("Executable could not start")));
    child.once("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`Executable exited with status ${code}`),
      ),
    );
    child.stdin.on("error", () => {});
    const relocate = (v: unknown): unknown =>
      typeof v === "string" && (v === cwd || v.startsWith(cwd + "/"))
        ? "/work" + v.slice(cwd.length)
        : Array.isArray(v)
          ? v.map(relocate)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [k, relocate(x)]),
              )
            : v;
    child.stdin.end(
      JSON.stringify(mode === "process" ? o.input : relocate(o.input)),
    );
  });
}
export function workspace(
  store: Store,
  ids: string[],
): {
  path: string;
  files: { hash: string; path: string }[];
  cleanup: () => void;
} {
  const path = mkdtempSync(join(tmpdir(), "bitswarm-run-"));
  const files: { hash: string; path: string }[] = [];
  try {
    for (const id of new Set(ids)) {
      const data = store.blob(id);
      assert(data, "Missing source object " + id);
      const rawPath = join(path, id);
      writeFileSync(rawPath, data, { mode: 0o600 });
      let index: Record<string, unknown>;
      try {
        index = JSON.parse(Buffer.from(data).toString());
      } catch {
        continue;
      }
      if (index?.type !== "bitswarm.file.v1") continue;
      assert(
        typeof index.name === "string" &&
          basename(index.name) === index.name &&
          index.name !== "." &&
          index.name !== ".." &&
          index.name.length <= 200,
        "Unsafe source filename",
      );
      assert(
        Array.isArray(index.chunks) &&
          index.chunks.length <= 10_000 &&
          index.chunks.every(isHash) &&
          isHash(index.sha256) &&
          Number.isSafeInteger(index.size),
        "Invalid file index",
      );
      const sourceDir = join(path, "sources", id);
      mkdirSync(sourceDir, { recursive: true });
      const target = join(sourceDir, index.name);
      restoreFile((blob) => store.blob(blob), id, target);
      files.push({ hash: id, path: target });
    }
    return {
      path,
      files,
      cleanup: () => rmSync(path, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(path, { recursive: true, force: true });
    throw e;
  }
}
export function materializeFiles(root: string, files: Record<string, string>) {
  assert(
    files &&
      typeof files === "object" &&
      !Array.isArray(files) &&
      Object.keys(files).length <= 1000,
    "Invalid generated file set",
  );
  let bytes = 0;
  for (const [path, contents] of Object.entries(files)) {
    assert(
      typeof contents === "string" &&
        path.length > 0 &&
        path.length < 500 &&
        !path.includes("\\") &&
        !path.includes("\0"),
      "Invalid generated file",
    );
    const target = resolve(root, path);
    assert(
      target.startsWith(resolve(root) + "/"),
      "Generated path escapes workspace",
    );
    bytes += Buffer.byteLength(contents);
    assert(bytes <= 8 * MAX_BLOB, "Generated files exceed 8 MiB");
    mkdirSync(resolve(target, ".."), { recursive: true });
    const parent = realpathSync(resolve(target, "..")),
      base = realpathSync(root);
    assert(
      parent === base || parent.startsWith(base + "/"),
      "Generated parent escapes workspace",
    );
    if (existsSync(target)) {
      assert(
        lstatSync(target).isFile() &&
          !lstatSync(target).isSymbolicLink() &&
          readFileSync(target, "utf8") === contents,
        "Generated file already exists with different contents",
      );
    } else writeFileSync(target, contents, { flag: "wx", mode: 0o600 });
  }
}
