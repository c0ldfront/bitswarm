#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import {
  assert,
  canonical,
  claimExpiration,
  digest,
  makeEvent,
  validateManifest,
  type Manifest,
} from "./core.ts";
import { planFile, restoreFile } from "./artifacts.ts";
import { formatSwarmLink, parseSwarmLink, peerOrigin } from "./link.ts";
import { checkpoint, control, propose } from "./control.ts";
import { credentials, grant, type Grant, type Auth } from "./access.ts";
import { verifyResult } from "./verification.ts";
import type { Isolation } from "./runtime.ts";
import { stateIdentity, Store, type Participation } from "./store.ts";
import { getManifest, request, requireToken, serve, sync } from "./network.ts";
import {
  claim,
  prepareTask,
  requestInput,
  runWorker,
  submit,
} from "./worker.ts";

const help = `BitSwarm — peer-to-peer work blocks for agents

bun run swarm <command> [options] [-- adapter arg...]

credits  --state DIR                         Inspect experimental contribution credits
mine     --state DIR [--result ID] [--file TRANSFER_IDS.json]
transfer --state DIR --to KEY --amount N [--fee N]
run      --state DIR --config FILE           Run autonomous planning/work/review
backup   --state DIR --output FILE           Encrypted, consistent project backup
restore-state --state NEW_DIR --file FILE
compact  --state DIR                         Archive terminal attempts and retain accounting
recipe   -- verifier-command args...         Hash a reproducible verifier recipe
keygen   --state DIR                         Create a local Ed25519 identity
init     --state DIR --manifest FILE         Create a swarm; empty validators uses local key
         [--taskFile BLOCK=FILE] [--optionalFile BLOCK=FILE]
         [--input FILE]                      Stream and seed an application (up to 2 GiB)
share    --state DIR [--peer URL ...]         Print a swarm:// invitation
preview  [--state DIR] swarm://...           Inspect a project before joining
participation --state DIR [--download metadata|tasks|mirror] [--upload results|cache]
         [--downloadBytes N] [--uploadBytes N] [--only BLOCK ...]
request-input --state DIR --block ID --hash ROOT --reason TEXT
join     --state DIR [--link] swarm://...     Verify a link and join via its peer hints
         --peer URL --swarm HASH             Alternative explicit bootstrap
peer     --state DIR --port 7331             Serve and gossip continuously
         [--host 127.0.0.1] [--peer URL ...]
sync     --state DIR --peer URL ...          One anti-entropy round with each peer
status   --state DIR                         Show work and review progress
put      --state DIR --file FILE             Seed a file as 256 KiB chunks + index
restore  --state DIR --hash ROOT --output P  Restore a file and verify full-file integrity
pin      --state DIR --hash HASH             Retain a local object through garbage collection
unpin    --state DIR --hash HASH
get      --state DIR --hash HASH --output P  Write a raw content-addressed object
claim    --state DIR --block ID [--ttl 300]   Reserve a ready block
submit   --state DIR --claim HASH --file P --summary TEXT
review   --state DIR --result HASH --verdict approve|reject --reason TEXT
work     --state DIR [--capability NAME ...] [--watch] [--ttl 300]
         -- executable args...              Run a locally configured JSON adapter
inspect  --state DIR --result HASH           Show evidence and review provenance
mesh     --state DIR [--listen MULTIADDR] [--bootstrap MULTIADDR] [--lan] [--relay] [--dht]
propose  --state DIR --file BLOCK.json --reason TEXT
admit    --state DIR --proposal HASH
verify   --state DIR --result HASH -- verifier-executable args...
invite   --state DIR --publicKey KEY [--role worker|reader|reviewer] [--output FILE]
         [--only BLOCK ...] [--root HASH ...]   Read scope for restricted projects
revoke   --state DIR --publicKey KEY
policy   --state DIR --file POLICY.json
cancel   --state DIR --block ID
retry    --state DIR --result HASH
renew    --state DIR --claim HASH [--ttl 300]
resolve  --state DIR --block ID --result HASH
checkpoint --state DIR
delegate --state DIR --publicKey KEY
recover  --state DIR --parent HASH --publicKey KEY
reconcile --state DIR --parent HASH --selected HASH
metrics  --state DIR
export   --state DIR [--output FILE]         Export accepted findings and provenance

gc       --state DIR                         Remove unreferenced objects
scoreboard --state DIR                       Show accepted contribution counts
install-handler [--output DIR] [--register]  Install a Linux swarm:// handler
open     swarm://...                         Preview using the project-specific identity

Networking reads BITSWARM_TOKEN (shared secret, minimum 32 characters).
Run peer and work against the same state directory in separate terminals.
`;

async function untilInterrupted(run: (signal: AbortSignal) => Promise<void>) {
  const stop = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    stop.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await run(stop.signal);
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let command = args.shift();
  if (command === "open") {
    const uri = args.shift();
    assert(uri && args.length === 0, "Open requires one swarm URI");
    const link = parseSwarmLink(uri);
    command = "preview";
    args.push(
      uri,
      "--state",
      join(
        process.env.BITSWARM_STATE_ROOT ||
          join(homedir(), ".local/share/bitswarm"),
        link.swarm,
      ),
    );
  }
  if (!command || command === "help" || command === "--help") {
    console.log(help);
    return;
  }
  assert(
    [
      "preview",
      "participation",
      "request-input",
      "keygen",
      "init",
      "join",
      "peer",
      "mesh",
      "share",
      "sync",
      "status",
      "put",
      "get",
      "restore",
      "pin",
      "unpin",
      "claim",
      "submit",
      "inspect",
      "review",
      "work",
      "propose",
      "admit",
      "cancel",
      "retry",
      "resolve",
      "checkpoint",
      "policy",
      "delegate",
      "invite",
      "revoke",
      "renew",
      "recover",
      "reconcile",
      "verify",
      "metrics",
      "gc",
      "scoreboard",
      "export",
      "install-handler",
      "run",
      "backup",
      "restore-state",
      "compact",
      "recipe",
      "credits",
      "mine",
      "transfer",
    ].includes(command),
    "Unknown command: " + command,
  );
  const separator = args.indexOf("--");
  const adapter = separator < 0 ? [] : args.splice(separator).slice(1);
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: ["join", "preview"].includes(command!),
    options: {
      download: { type: "string" },
      upload: { type: "string" },
      downloadBytes: { type: "string" },
      uploadBytes: { type: "string" },
      root: { type: "string", multiple: true },
      taskFile: { type: "string", multiple: true },
      optionalFile: { type: "string", multiple: true },
      config: { type: "string" },
      public: { type: "boolean" },
      workBits: { type: "string", default: "12" },
      to: { type: "string" },
      amount: { type: "string" },
      fee: { type: "string", default: "0" },
      state: { type: "string", default: ".swarm" },
      tokens: { type: "string" },
      costMicros: { type: "string" },
      concurrency: { type: "string", default: "1" },
      publicKey: { type: "string" },
      role: { type: "string", default: "worker" },
      expires: { type: "string", default: "86400" },
      invite: { type: "string" },
      parent: { type: "string" },
      selected: { type: "string" },
      proposal: { type: "string" },
      isolation: {
        type: "string",
        default: command === "verify" ? "bwrap" : "process",
      },
      image: { type: "string" },
      listen: { type: "string", multiple: true },
      bootstrap: { type: "string", multiple: true, default: [] },
      relay: { type: "boolean" },
      lan: { type: "boolean" },
      dht: { type: "boolean" },
      discover: { type: "boolean" },
      signed: { type: "boolean" },
      register: { type: "boolean" },
      metadataOnly: { type: "boolean" },
      only: { type: "string", multiple: true },
      manifest: { type: "string" },
      input: { type: "string" },
      peer: { type: "string", multiple: true, default: [] },
      swarm: { type: "string" },
      link: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "7331" },
      block: { type: "string" },
      claim: { type: "string" },
      result: { type: "string" },
      file: { type: "string" },
      hash: { type: "string" },
      output: { type: "string" },
      summary: { type: "string" },
      reason: { type: "string" },
      verdict: { type: "string" },
      capability: { type: "string", multiple: true, default: [] },
      ttl: { type: "string", default: "300" },
      watch: { type: "boolean", default: false },
    },
  });
  const need = (value: string | undefined, name: string) => {
    assert(value, `Missing --${name}`);
    return value;
  };
  const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  assert(
    ["process", "bwrap", "docker"].includes(v.isolation!),
    "Invalid isolation mode",
  );
  const ttl = Number(v.ttl) * 1000;
  if (["claim", "renew", "work"].includes(command))
    assert(
      Number.isSafeInteger(ttl) && ttl >= 2000 && ttl <= 3600000,
      "TTL must be 2–3600 seconds",
    );
  const token = process.env.BITSWARM_TOKEN || "";
  if (command === "install-handler") {
    const { installHandler } = await import("./desktop.ts");
    const result = installHandler(
      v.output ||
        join(
          process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
          "applications",
        ),
      process.execPath,
      fileURLToPath(import.meta.url),
    );
    if (v.register) execFileSync(result.register[0], result.register.slice(1));
    out(result);
    return;
  }
  if (command === "keygen" || command === "init") {
    const who = stateIdentity(v.state!);
    if (command === "keygen") {
      out({ publicKey: who.publicKey });
      return;
    }
    const m: Manifest = JSON.parse(
      readFileSync(need(v.manifest, "manifest"), "utf8"),
    );
    if (Array.isArray(m.validators) && m.validators.length === 0)
      m.validators = [who.publicKey];
    const input = v.input ? planFile(v.input) : undefined;
    if (input)
      for (const b of m.blocks.filter((b) => b.requires.length === 0))
        b.inputs = [...new Set([...b.inputs, input.root])];
    const files: ReturnType<typeof planFile>[] = [];
    for (const [items, optional] of [
      [v.taskFile ?? [], false],
      [v.optionalFile ?? [], true],
    ] as const) {
      for (const item of items) {
        const equal = item.indexOf("=");
        const block = m.blocks.find((b) => b.id === item.slice(0, equal));
        assert(equal > 0 && block, "Expected BLOCK=FILE for an existing task");
        const file = planFile(item.slice(equal + 1)),
          field = optional ? "optionalInputs" : "inputs";
        block[field] = [...new Set([...(block[field] ?? []), file.root])];
        files.push(file);
      }
    }
    validateManifest(m);
    const store = new Store(v.state!, m, undefined, (target) => {
      for (const file of files)
        file.seed((data, id) => target.addBlob(data, id));
      input?.seed((data, id) => target.addBlob(data, id));
    });
    try {
      out({
        swarm: digest(m),
        publicKey: store.who.publicKey,
        input: input?.root,
      });
    } finally {
      store.close();
    }
    return;
  }
  const setProfile = (store: Store, fresh = false) => {
    if (
      !fresh &&
      !v.download &&
      !v.upload &&
      v.downloadBytes === undefined &&
      v.uploadBytes === undefined &&
      !v.only &&
      !v.metadataOnly
    )
      return;
    const previous = store.participation();
    const profile: Participation = {
      download: previous?.download ?? (fresh ? "tasks" : "mirror"),
      upload: previous?.upload ?? (fresh ? "results" : "cache"),
      ...previous,
    };
    if (
      !fresh &&
      !previous &&
      store.selection() &&
      !v.download &&
      !v.only &&
      !v.metadataOnly
    ) {
      profile.download = store.selection()!.length ? "tasks" : "metadata";
      if (profile.download === "tasks") profile.only = store.selection();
    }
    if (v.download || v.only || v.metadataOnly) {
      assert(
        !(v.metadataOnly && (v.only || v.download)) &&
          !(v.only && v.download && v.download !== "tasks"),
        "Conflicting download choices",
      );
      profile.download = (v.download ||
        (v.only ? "tasks" : "metadata")) as Participation["download"];
      delete profile.only;
      if (v.only) profile.only = v.only;
    }
    if (v.only && !v.only.length) throw Error("Empty task list");
    if (v.upload) profile.upload = v.upload as Participation["upload"];
    if (v.downloadBytes !== undefined)
      profile.downloadBytes = Number(v.downloadBytes);
    if (v.uploadBytes !== undefined)
      profile.uploadBytes = Number(v.uploadBytes);
    store.configure(profile);
  };
  if (command === "join" || command === "preview") {
    assert(
      positionals.length <= 1 && !(v.link && positionals.length),
      "Provide one swarm link",
    );
    const uri = v.link || positionals[0];
    const link = uri ? parseSwarmLink(uri) : undefined;
    assert(
      !link || !v.swarm || link.swarm === v.swarm,
      "Conflicting swarm identities",
    );
    const expected = link?.swarm || need(v.swarm, "swarm");
    const savedGrant = join(v.state!, "access.json");
    let invitation: Grant | undefined;
    if (v.invite) {
      invitation = JSON.parse(readFileSync(v.invite, "utf8")) as Grant;
      assert(
        invitation.swarm === expected,
        "Invitation belongs to another swarm",
      );
    } else if (!v.signed && !v.public && existsSync(savedGrant)) {
      const saved: Grant = JSON.parse(readFileSync(savedGrant, "utf8"));
      if (saved.swarm === expected) invitation = saved;
    }
    if (!invitation && !v.signed && !v.public && token) requireToken(token);
    const peers = new Set([
      ...v.peer!.map(peerOrigin),
      ...(link?.peers ?? []),
      ...Store.savedPeers(v.state!, expected),
    ]);
    assert(
      peers.size > 0 || v.bootstrap!.length || v.lan,
      "No bootstrap hints; add --peer URL, --bootstrap MULTIADDR, or --lan",
    );
    const joiningIdentity = stateIdentity(v.state!, command === "join");
    let auth: Auth =
      v.public || (!token && !invitation && !v.signed)
        ? {
            identity: joiningIdentity,
            swarm: expected,
            powBits: Number(v.workBits),
          }
        : v.signed
          ? { identity: joiningIdentity, swarm: expected }
          : token;
    if (invitation) {
      assert(
        invitation.subject === joiningIdentity.publicKey,
        "Invitation belongs to a different contributor identity",
      );
      const keyPath = join(v.state!, "identity.json");
      assert(
        existsSync(keyPath),
        "Run keygen for this state before requesting an invitation",
      );
      auth = {
        identity: joiningIdentity,
        grant: invitation,
      };
    }
    const failures: string[] = [];
    let dialer:
      Awaited<ReturnType<typeof import("./mesh.ts").createDialer>> | undefined;
    const getDialer = async () => {
      if (!dialer) {
        const { createDialer } = await import("./mesh.ts");
        dialer = await createDialer(
          v.state!,
          joiningIdentity.publicKey,
          expected,
          v.bootstrap,
          v.lan,
          command === "preview",
        );
      }
      return dialer;
    };
    async function* candidates() {
      yield* peers;
      if (!v.bootstrap!.length && !v.lan) return;
      const mesh = await getDialer();
      const routes = [
        ...(await mesh.findPeers()),
        ...v.bootstrap!.map((a) =>
          peerOrigin("libp2p:" + a.replace(/^libp2p:/, "")),
        ),
      ];
      for (const peer of new Set(routes)) if (!peers.has(peer)) yield peer;
    }
    try {
      for await (const peer of candidates()) {
        let store: Store | undefined;
        try {
          if (peer.startsWith("libp2p:")) await getDialer();
          if (
            command === "preview" &&
            !token &&
            !invitation &&
            !v.signed &&
            !v.public
          ) {
            try {
              const brief = JSON.parse(
                Buffer.from(
                  await request(peer, "", "/v1/public-preview", {}, 8192),
                ).toString(),
              );
              assert(
                brief.swarm === expected && typeof brief.summary === "string",
                "Unexpected preview",
              );
              out({
                swarm: expected,
                peer,
                advertisedSummary: brief.summary,
                verified: false,
              });
              return;
            } catch {}
          }
          const m: Manifest = await getManifest(peer, auth);
          validateManifest(m);
          assert(
            digest(m) === expected,
            "Manifest does not match pinned swarm ID",
          );
          if (command === "preview") {
            try {
              const preview = JSON.parse(
                Buffer.from(
                  await request(peer, auth, "/v1/preview"),
                ).toString(),
              );
              assert(preview.swarm === expected, "Preview swarm mismatch");
              out({ ...preview, manifestName: m.name, peer });
            } catch (error) {
              if (m.version >= 4 || !String(error).includes("404")) throw error;
              out({
                swarm: expected,
                manifestName: m.name,
                peer,
                goal: m.description,
                source: "pinned genesis",
                tasks: m.blocks.map((b) => ({
                  id: b.id,
                  title: b.title,
                  requires: b.requires,
                  capabilities: b.capabilities,
                  declaredInputBytes: null,
                  status: "unknown",
                  output: b.contract?.schema,
                  verifier: b.contract?.verifier,
                  maxTokens: b.contract?.maxTokens,
                })),
              });
            }
            return;
          }
          const fresh = !existsSync(join(v.state!, "manifest.json"));
          store = new Store(v.state!, m, {
            download: "tasks",
            upload: "results",
          });
          setProfile(store, fresh);
          const result = await sync(store, peer, auth, {
            metadataOnly: v.metadataOnly,
            blocks: v.only,
          });
          if (invitation && v.invite) {
            const temporary = savedGrant + "." + crypto.randomUUID();
            try {
              writeFileSync(temporary, canonical(invitation), {
                mode: 0o600,
                flag: "wx",
              });
              renameSync(temporary, savedGrant);
            } finally {
              rmSync(temporary, { force: true });
            }
          }
          out({
            swarm: digest(m),
            publicKey: store.who.publicKey,
            peer,
            ...result,
          });
          return;
        } catch (e) {
          failures.push(`${peer}: ${e instanceof Error ? e.message : e}`);
        } finally {
          store?.close();
        }
      }
      throw new Error("No bootstrap peer succeeded: " + failures.join("; "));
    } finally {
      await dialer?.stop();
    }
  }
  if (command === "restore-state") {
    const { restoreBackup } = await import("./operations.ts");
    out(
      restoreBackup(
        need(v.file, "file"),
        v.state!,
        process.env.BITSWARM_BACKUP_PASSPHRASE || "",
      ),
    );
    return;
  }
  if (command === "recipe") {
    out({ hash: await (await import("./recipe.ts")).recipeHash(adapter) });
    return;
  }
  const automationConfig =
    command === "run"
      ? JSON.parse(readFileSync(need(v.config, "config"), "utf8"))
      : undefined;
  const store = new Store(v.state!);
  const dialer =
    ["peer", "work", "claim", "verify", "sync", "run"].includes(command) &&
    [...store.peers(), ...v.peer!, ...(automationConfig?.peers ?? [])].some(
      (p) => p.startsWith("libp2p:"),
    )
      ? await (
          await import("./mesh.ts")
        ).createDialer(
          store.directory,
          store.who.publicKey,
          digest(store.manifest),
          [],
          false,
          true,
        )
      : undefined;
  try {
    const auth = credentials(store, token);
    if (
      [
        "sync",
        "peer",
        "mesh",
        "participation",
        "work",
        "claim",
        "run",
      ].includes(command)
    )
      setProfile(store);
    switch (command) {
      case "participation":
        out({
          profile: store.participation() ?? {
            download: store.selection()
              ? store.selection()!.length
                ? "tasks"
                : "metadata"
              : "mirror",
            only: store.selection(),
            upload: "cache",
          },
          downloadedBytes: store.usedBytes("download"),
          uploadedBytes: store.usedBytes("upload"),
        });
        break;
      case "request-input":
        out(
          requestInput(
            store,
            need(v.block, "block"),
            need(v.hash, "hash"),
            need(v.reason, "reason"),
          ),
        );
        break;
      case "backup":
        out(
          (await import("./operations.ts")).backup(
            store,
            need(v.output, "output"),
            process.env.BITSWARM_BACKUP_PASSPHRASE || "",
          ),
        );
        break;
      case "compact":
        out((await import("./operations.ts")).compact(store));
        break;
      case "run": {
        const config = automationConfig;
        const server = config.listen
          ? serve(store, token, config.listen.port, config.listen.host)
          : undefined;
        try {
          await untilInterrupted(async (signal) => {
            const { runAutomation } = await import("./autopilot.ts");
            out(await runAutomation(store, config, signal));
          });
        } finally {
          server?.stop(true);
        }
        break;
      }
      case "credits": {
        const c = (await import("./credits.ts")).creditState(store);
        out({
          head: c.tip.head,
          height: c.tip.height,
          confirmedHead: c.confirmed.head,
          balances: c.balances,
          confirmedBalances: c.confirmedBalances,
        });
        break;
      }
      case "mine":
        out(
          (await import("./credits.ts")).mineCredits(
            store,
            v.result,
            v.file ? JSON.parse(readFileSync(v.file, "utf8")) : [],
          ),
        );
        break;
      case "transfer":
        out(
          (await import("./credits.ts")).transferCredits(
            store,
            need(v.to, "to"),
            Number(need(v.amount, "amount")),
            Number(v.fee),
          ),
        );
        break;
      case "peer": {
        const port = Number(v.port);
        assert(
          Number.isInteger(port) && port >= 1 && port <= 65535,
          "Invalid port",
        );
        v.peer!.forEach((p) => store.rememberPeer(peerOrigin(p)));
        const server = serve(store, token, port, v.host);
        out({
          listening: server.url.toString(),
          swarm: digest(store.manifest),
          publicKey: store.who.publicKey,
        });
        let busy = false;
        const gossip = async () => {
          if (busy) return;
          busy = true;
          try {
            for (const peer of store.peers()) {
              try {
                await sync(store, peer, credentials(store, token), {
                  metadataOnly: v.metadataOnly,
                  blocks: v.only,
                  discover: v.discover,
                });
              } catch (e) {
                store.peerFailure(peer);
                console.error(
                  `Sync ${peer}: ${e instanceof Error ? e.message : e}`,
                );
              }
            }
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(gossip, 2000);
        void gossip();
        const stop = () => {
          clearInterval(timer);
          server.stop(true);
          process.exit(0);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await new Promise(() => {});
        break;
      }
      case "mesh": {
        const { startMesh } = await import("./mesh.ts");
        const mesh = await startMesh(store, token, {
          listen: v.listen,
          bootstrap: v.bootstrap,
          relay: v.relay,
          lan: v.lan,
          dht: v.dht,
        });
        out({ swarm: digest(store.manifest), addresses: mesh.addresses() });
        let busy = false;
        const timer = setInterval(async () => {
          if (busy) return;
          busy = true;
          try {
            for (const p of store.peers())
              try {
                await sync(store, p, credentials(store, token), {
                  metadataOnly: v.metadataOnly,
                  blocks: v.only,
                  discover: v.discover,
                });
              } catch (e) {
                store.peerFailure(p);
                console.error(e instanceof Error ? e.message : e);
              }
          } finally {
            busy = false;
          }
        }, 2000);
        process.once("SIGINT", () => {
          clearInterval(timer);
          void mesh.stop().then(() => process.exit(0));
        });
        process.once("SIGTERM", () => {
          clearInterval(timer);
          void mesh.stop().then(() => process.exit(0));
        });
        await new Promise(() => {});
        break;
      }
      case "propose":
        out(
          propose(
            store,
            JSON.parse(readFileSync(need(v.file, "file"), "utf8")),
            need(v.reason, "reason"),
          ),
        );
        break;
      case "admit":
        out(
          control(store, {
            type: "add",
            proposal: need(v.proposal, "proposal"),
          }),
        );
        break;
      case "cancel":
        out(control(store, { type: "cancel", block: need(v.block, "block") }));
        break;
      case "retry":
        out(
          control(
            store,
            v.block
              ? { type: "resume", block: v.block }
              : { type: "retry", result: need(v.result, "result") },
          ),
        );
        break;
      case "resolve":
        out(
          control(store, {
            type: "resolve",
            block: need(v.block, "block"),
            result: need(v.result, "result"),
          }),
        );
        break;
      case "checkpoint":
        out(checkpoint(store));
        break;
      case "policy":
        out(
          control(store, {
            type: "policy",
            policy: JSON.parse(readFileSync(need(v.file, "file"), "utf8")),
          }),
        );
        break;
      case "delegate":
        out(
          control(store, {
            type: "delegate",
            key: need(v.publicKey, "publicKey"),
          }),
        );
        break;
      case "revoke":
        out(
          control(store, {
            type: "member",
            key: need(v.publicKey, "publicKey"),
            role: "worker",
            enabled: false,
          }),
        );
        break;
      case "invite": {
        assert(
          store.manifest.restricted || !(v.only || v.root),
          "Scoped invitations require a restricted swarm",
        );
        const key = need(v.publicKey, "publicKey");
        assert(
          ["worker", "reader", "reviewer"].includes(v.role!),
          "Invalid contributor role",
        );
        const invitation = store.db
          .transaction(() => {
            const ticket = grant(
              store,
              key,
              v.role as Grant["role"],
              Date.now() + Number(v.expires) * 1000,
              store.manifest.restricted
                ? { blocks: v.only ?? [], roots: v.root ?? [] }
                : undefined,
            );
            control(store, {
              type: "member",
              key,
              role: ticket.role,
              enabled: true,
              ...(v.tokens !== undefined || v.costMicros !== undefined
                ? {
                    budget: {
                      maxTokens: Number(v.tokens || 0),
                      maxCostMicros: Number(v.costMicros || 0),
                      maxConcurrent: Number(v.concurrency),
                    },
                  }
                : {}),
            });
            if (v.output)
              writeFileSync(v.output, canonical(ticket), {
                flag: "wx",
                mode: 0o600,
              });
            return ticket;
          })
          .immediate();
        if (!v.output) out(invitation);
        break;
      }
      case "renew": {
        out(
          store.db
            .transaction(() => {
              const lease = store.event(need(v.claim, "claim")),
                now = Date.now();
              assert(
                lease?.payload.kind === "claim" &&
                  lease.author === store.who.publicKey,
                "Renew a live local claim",
              );
              const state = store
                .state(now)
                .find((s) => s.claims.some((c) => c.id === lease.id));
              assert(
                state &&
                  !["cancelled", "blocked", "accepted"].includes(state.status),
                "Renew a live local claim",
              );
              const expires = Math.min(
                now + ttl,
                lease.time + (state.block.contract?.timeoutMs ?? 3600000),
              );
              const event = makeEvent(
                store.manifest,
                store.who,
                { kind: "renew", claim: lease.id, expires },
                now,
              );
              store.addEvent(event);
              return event;
            })
            .immediate(),
        );
        break;
      }
      case "recover": {
        const event = makeEvent(store.manifest, store.who, {
          kind: "recover",
          parent: need(v.parent, "parent"),
          key: need(v.publicKey, "publicKey"),
        });
        store.addEvent(event);
        out(event);
        break;
      }
      case "reconcile": {
        const event = makeEvent(store.manifest, store.who, {
          kind: "reconcile",
          parent: need(v.parent, "parent"),
          selected: need(v.selected, "selected"),
        });
        store.addEvent(event);
        out(event);
        break;
      }
      case "verify":
        await untilInterrupted(async (signal) => {
          out(
            await verifyResult(
              store,
              need(v.result, "result"),
              adapter,
              v.isolation as Isolation,
              v.image,
              signal,
            ),
          );
        });
        break;
      case "gc":
        out(store.collect());
        break;
      case "scoreboard":
        out(store.scoreboard());
        break;
      case "metrics":
        out(store.metrics());
        break;
      case "share":
        console.log(
          formatSwarmLink({
            swarm: digest(store.manifest),
            name: store.manifest.name,
            peers: v.peer!,
          }),
        );
        break;
      case "sync":
        assert(v.peer!.length, "Provide --peer");
        for (const p of v.peer!)
          out({
            peer: p,
            ...(await sync(store, p, auth, {
              metadataOnly: v.metadataOnly,
              blocks: v.only,
              discover: v.discover,
            })),
          });
        break;
      case "status":
        out({
          swarm: digest(store.manifest),
          name: store.manifest.name,
          publicKey: store.who.publicKey,
          planner: store.governance().planner,
          controlHead: store.governance().head,
          controlConflict: store.governance().conflict,
          usage: store.usage(),
          blocks: store.state().map((s) => ({
            id: s.block.id,
            title: s.block.title,
            status: s.status,
            claims: s.claims.map((e) => ({
              id: e.id,
              author: e.author,
              expires: claimExpiration(
                e,
                store.events(),
                s.block.contract?.timeoutMs,
              ),
            })),
            results: s.candidates.map((c) => ({
              id: c.event.id,
              eligible: c.eligible,
              status: c.status,
              verification: c.verification,
              author: c.event.author,
              artifact:
                c.event.payload.kind === "result"
                  ? c.event.payload.artifact
                  : undefined,
              summary:
                c.event.payload.kind === "result"
                  ? c.event.payload.summary
                  : undefined,
              approvals: c.approvals.length,
              rejections: c.rejections.length,
            })),
          })),
        });
        break;
      case "put": {
        const file = planFile(need(v.file, "file"));
        store.db
          .transaction(() => {
            file.seed((data, id) => store.addBlob(data, id));
            store.db
              .query("INSERT OR IGNORE INTO pins VALUES (?)")
              .run(file.root);
          })
          .immediate();
        out({ root: file.root, objects: file.objects });
        break;
      }
      case "pin": {
        const id = need(v.hash, "hash");
        assert(store.hasBlob(id), "Object not found");
        store.db.query("INSERT OR IGNORE INTO pins VALUES (?)").run(id);
        out({ pinned: id });
        break;
      }
      case "unpin": {
        const id = need(v.hash, "hash");
        store.db.query("DELETE FROM pins WHERE id=?").run(id);
        out({ unpinned: id });
        break;
      }
      case "restore":
        out(
          restoreFile(
            (id) => store.blob(id),
            need(v.hash, "hash"),
            need(v.output, "output"),
          ),
        );
        break;
      case "get": {
        const id = need(v.hash, "hash");
        const data = store.blob(id);
        assert(data, "Object not found");
        writeFileSync(need(v.output, "output"), data, { flag: "wx" });
        break;
      }
      case "claim":
        await prepareTask(store, need(v.block, "block"));
        out(claim(store, need(v.block, "block"), ttl));
        break;
      case "submit":
        out(
          submit(
            store,
            need(v.claim, "claim"),
            readFileSync(need(v.file, "file")),
            need(v.summary, "summary"),
          ),
        );
        break;
      case "inspect": {
        const result = store.event(need(v.result, "result"));
        assert(result?.payload.kind === "result", "Unknown result");
        const bytes = store.blob(result.payload.artifact);
        out({
          result,
          claim: store.event(result.payload.claim),
          artifact: bytes
            ? {
                hash: result.payload.artifact,
                encoding: "utf8",
                data: Buffer.from(bytes).toString("utf8"),
              }
            : { missing: true },
          reviews: store
            .events()
            .filter(
              (e) =>
                e.payload.kind === "review" && e.payload.result === result.id,
            ),
        });
        break;
      }
      case "review": {
        const id = need(v.result, "result");
        const result = store.event(id);
        assert(result?.payload.kind === "result", "Unknown result");
        assert(
          result.author !== store.who.publicKey,
          "Independent review required",
        );
        assert(
          ["approve", "reject"].includes(v.verdict || ""),
          "Expected --verdict approve|reject",
        );
        const event = makeEvent(store.manifest, store.who, {
          kind: "review",
          result: id,
          verdict: v.verdict as "approve" | "reject",
          reason: need(v.reason, "reason"),
        });
        store.addEvent(event);
        out(event);
        break;
      }
      case "work": {
        assert(adapter.length, "Provide adapter after --");
        await untilInterrupted(async (signal) => {
          do {
            try {
              const event = await runWorker(store, adapter, v.capability, ttl, {
                isolation: v.isolation as Isolation,
                image: v.image,
                signal,
              });
              out(
                event
                  ? {
                      submitted: event.id,
                      block:
                        event.payload.kind === "result"
                          ? event.payload.block
                          : "",
                    }
                  : { idle: true },
              );
            } catch (e) {
              if (signal.aborted || !v.watch) throw e;
              console.error(e instanceof Error ? e.message : e);
            }
            if (v.watch) await delay(2000, undefined, { signal });
          } while (v.watch && !signal.aborted);
        });
        break;
      }
      case "export": {
        const report = {
          swarm: digest(store.manifest),
          manifest: store.manifest,
          blocks: store.state().map((s) => ({
            id: s.block.id,
            status: s.status,
            ...(s.accepted?.payload.kind === "result"
              ? {
                  result: s.accepted,
                  artifact: {
                    hash: s.accepted.payload.artifact,
                    encoding: "base64",
                    data: Buffer.from(
                      store.blob(s.accepted.payload.artifact)!,
                    ).toString("base64"),
                  },
                  reviews: store
                    .events()
                    .filter(
                      (e) =>
                        e.payload.kind === "review" &&
                        e.payload.result === s.accepted!.id,
                    ),
                }
              : {}),
          })),
          events: store.events(),
        };
        if (v.output)
          writeFileSync(v.output, JSON.stringify(report, null, 2), {
            flag: "wx",
          });
        else out(report);
        break;
      }
      default:
        throw new Error("Unknown command: " + command + "\n" + help);
    }
  } finally {
    await dialer?.stop();
    store.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
