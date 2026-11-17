import { setTimeout as delay } from "node:timers/promises";
import { assert, makeEvent, verificationMatches } from "./core.ts";
import { recipeHash } from "./recipe.ts";
import { control, checkpoint } from "./control.ts";
import { runWorker } from "./worker.ts";
import { verifyResult } from "./verification.ts";
import { hydrateTask, sync } from "./network.ts";
import { credentials } from "./access.ts";
import type { Store } from "./store.ts";
import type { Isolation } from "./runtime.ts";
export type Automation = {
  peers?: string[];
  worker?: {
    command: string[];
    capabilities: string[];
    ttlMs?: number;
    isolation?: Isolation;
    image?: string;
  };
  planner?: {
    maxBlocks: number;
    capabilities: string[];
    verifiers: string[];
    checkpoint?: boolean;
  };
  reviewer?: {
    verifiers: Record<string, string[]>;
    autoApprove: boolean;
    isolation?: Isolation;
    image?: string;
  };
  pollMs?: number;
  deadlineMs?: number;
  goalBlocks?: string[];
  listen?: { host?: string; port: number };
  stopWhenComplete?: boolean;
};
export function journal(
  store: Store,
  key: string,
  status: string,
  detail: unknown,
) {
  store.db
    .query(
      "INSERT INTO automation VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,detail=excluded.detail,time=excluded.time",
    )
    .run(key, status, JSON.stringify(detail), Date.now());
}
export async function automationStep(
  store: Store,
  config: Automation,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const g = store.governance();
  assert(!g.conflict, "Automation paused by authority fork");
  if (config.planner && g.planner === store.who.publicKey) {
    const admitted = new Set(g.manifest.blocks.map((b) => b.id));
    for (const event of store.events())
      if (
        event.payload.kind === "proposal" &&
        !admitted.has(event.payload.block.id)
      ) {
        const b = event.payload.block,
          policy = config.planner;
        if (
          admitted.size >= policy.maxBlocks ||
          !b.contract ||
          !b.contract.verifier ||
          !policy.verifiers.includes(b.contract.verifier) ||
          !b.capabilities.every((c) => policy.capabilities.includes(c)) ||
          ![
            ...store.expandRoots([...b.inputs, ...(b.optionalInputs ?? [])]),
          ].every(store.hasBlob)
        ) {
          journal(
            store,
            event.id,
            "rejected",
            "Proposal exceeds locally authorized admission policy",
          );
          continue;
        }
        if (!b.requires.every((id) => admitted.has(id))) continue;
        try {
          control(store, { type: "add", proposal: event.id });
          admitted.add(b.id);
          journal(store, event.id, "admitted", { block: b.id });
        } catch (e) {
          journal(store, event.id, "blocked", String(e));
        }
      }
  }
  const profile = store.participation();
  if (
    config.reviewer &&
    store.manifest.validators.includes(store.who.publicKey) &&
    profile?.download === "tasks"
  ) {
    for (const block of g.manifest.blocks) {
      if (
        !block.contract?.verifier ||
        !config.reviewer.verifiers[block.contract.verifier] ||
        (profile.only && !profile.only.includes(block.id))
      )
        continue;
      const results = store
        .events()
        .flatMap((e) =>
          e.payload.kind === "result" &&
          e.payload.block === block.id &&
          e.author !== store.who.publicKey
            ? [e.payload.artifact]
            : [],
        );
      if (results.length)
        await hydrateTask(
          store,
          block.id,
          () =>
            results.every(store.hasBlob) &&
            [...(store.wanted() ?? [])].every(store.hasBlob),
          signal,
          config.peers,
        );
    }
  }
  if (
    config.reviewer &&
    store.manifest.validators.includes(store.who.publicKey)
  )
    for (const state of store.state())
      for (const candidate of state.candidates) {
        if (
          candidate.event.author === store.who.publicKey ||
          candidate.status !== "pending" ||
          state.status === "cancelled" ||
          profile?.download === "metadata" ||
          (profile?.only && !profile.only.includes(state.block.id)) ||
          !candidate.eligible
        )
          continue;
        const existing = store
          .events()
          .some(
            (e) =>
              e.author === store.who.publicKey &&
              e.payload.kind === "review" &&
              e.payload.result === candidate.event.id,
          );
        const verifier = state.block.contract?.verifier;
        const command = verifier
          ? config.reviewer.verifiers[verifier]
          : undefined;
        if (!verifier || !command) {
          journal(
            store,
            candidate.event.id,
            "blocked",
            "No locally approved executable verifier",
          );
          continue;
        }
        try {
          signal?.throwIfAborted();
          const cached = store
            .events()
            .filter(
              (e) =>
                e.author === store.who.publicKey &&
                verificationMatches(
                  e,
                  state.block,
                  candidate.event.id,
                  store.blob.bind(store),
                ),
            );
          if (existing && cached.length) continue;
          const recipe = cached.length ? await recipeHash(command) : undefined;
          let attestation = cached.find((e) =>
            verificationMatches(
              e,
              state.block,
              candidate.event.id,
              store.blob.bind(store),
              recipe,
            ),
          );
          if (!attestation)
            attestation = await verifyResult(
              store,
              candidate.event.id,
              command,
              config.reviewer.isolation,
              config.reviewer.image,
              signal,
              config.peers,
            );
          signal?.throwIfAborted();
          if (
            attestation.payload.kind === "verification" &&
            config.reviewer.autoApprove &&
            !existing
          ) {
            const latest = store
              .state()
              .find((s) => s.block.id === state.block.id);
            const result = latest?.candidates.find(
              (c) => c.event.id === candidate.event.id,
            );
            const current = store.governance();
            if (
              !result?.eligible ||
              result.status === "expired" ||
              latest?.status === "cancelled" ||
              current.conflict ||
              current.members?.get(store.who.publicKey)?.enabled === false
            )
              continue;
            store.addEvent(
              makeEvent(store.manifest, store.who, {
                kind: "review",
                result: candidate.event.id,
                verdict: attestation.payload.passed ? "approve" : "reject",
                reason:
                  "Automatic policy: locally executed verifier " + verifier,
              }),
            );
            journal(store, candidate.event.id, "reviewed", {
              passed: attestation.payload.passed,
            });
          }
        } catch (e) {
          signal?.throwIfAborted();
          journal(store, candidate.event.id, "blocked", String(e));
        }
      }
  signal?.throwIfAborted();
  if (
    config.planner?.checkpoint &&
    store.governance().planner === store.who.publicKey
  )
    checkpoint(store);
}
export async function runAutomation(
  store: Store,
  config: Automation,
  signal?: AbortSignal,
) {
  const deadlineMs = config.deadlineMs ?? 3_600_000,
    pollMs = config.pollMs ?? 500;
  assert(
    Number.isSafeInteger(pollMs) &&
      pollMs >= 50 &&
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0,
    "Invalid automation timing",
  );
  const started = Date.now();
  const lifecycle = new AbortController();
  const stop = () => lifecycle.abort(new Error("Automation stopped"));
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const active = lifecycle.signal;
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const scheduleDeadline = () => {
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0)
      lifecycle.abort(new Error("Automation deadline reached"));
    else
      deadlineTimer = setTimeout(
        scheduleDeadline,
        Math.min(remaining, 2_147_483_647),
      );
  };
  scheduleDeadline();
  let gossipJob: Promise<void> | undefined;
  const gossip = () => {
    if (gossipJob) return gossipJob;
    gossipJob = (async () => {
      const peers = [...new Set(config.peers ?? store.peers())];
      for (const [index, peer] of peers.entries()) {
        if (active.aborted) break;
        // Reserve time for the remaining peers and one local scheduling turn.
        const remaining = deadlineMs - (Date.now() - started);
        const window = Math.max(
          1,
          Math.floor(remaining / (peers.length - index + 1)),
        );
        const peerStop = new AbortController();
        const timer =
          window <= 2_147_483_647
            ? setTimeout(
                () => peerStop.abort(new Error("Peer sync window elapsed")),
                window,
              )
            : undefined;
        try {
          await sync(
            store,
            peer,
            credentials(store, process.env.BITSWARM_TOKEN || ""),
            { signal: AbortSignal.any([active, peerStop.signal]) },
          );
        } catch (e) {
          if (!active.aborted)
            journal(store, "peer:" + peer, "offline", String(e));
        } finally {
          clearTimeout(timer);
        }
      }
    })().finally(() => {
      gossipJob = undefined;
    });
    return gossipJob;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let worker: Promise<unknown> | undefined;
  try {
    active.throwIfAborted();
    await gossip();
    timer = setInterval(() => void gossip(), Math.min(pollMs, 2_147_483_647));
    for (;;) {
      active.throwIfAborted();
      await automationStep(store, config, active);
      active.throwIfAborted();
      const states = store.state();
      if (
        config.stopWhenComplete &&
        states.some((s) => s.status === "exhausted")
      )
        throw new Error("Automation stopped: task attempts exhausted");
      if (
        config.stopWhenComplete &&
        states.some(
          (s) =>
            s.status === "cancelled" && config.goalBlocks?.includes(s.block.id),
        )
      )
        throw new Error("Automation stopped: goal block cancelled");
      if (
        config.stopWhenComplete &&
        (!config.goalBlocks ||
          config.goalBlocks.every((id) =>
            states.some((s) => s.block.id === id),
          )) &&
        states.every((s) => ["accepted", "cancelled"].includes(s.status))
      ) {
        const before = JSON.stringify(store.inventory());
        await gossipJob;
        // A stopped sync can still have committed part of its batch.
        await gossip();
        active.throwIfAborted();
        if (JSON.stringify(store.inventory()) !== before) continue;
        return {
          complete: true,
          elapsedMs: Date.now() - started,
          blocks: states.length,
        };
      }
      if (
        config.worker &&
        !worker &&
        states.some(
          (s) =>
            (s.status === "ready" ||
              (store.participation()?.download === "tasks" &&
                s.status === "blocked")) &&
            s.block.capabilities.every((c) =>
              config.worker!.capabilities.includes(c),
            ),
        )
      ) {
        const w = config.worker;
        worker = runWorker(
          store,
          w.command,
          w.capabilities,
          w.ttlMs ?? 300000,
          {
            isolation: w.isolation,
            image: w.image,
            signal: active,
            peers: config.peers,
          },
        )
          .catch((e) => journal(store, "worker", "failed", String(e)))
          .finally(() => {
            worker = undefined;
          });
      }
      await delay(Math.min(pollMs, 2_147_483_647), undefined, {
        signal: active,
      });
    }
  } catch (e) {
    active.throwIfAborted();
    throw e;
  } finally {
    clearInterval(timer);
    clearTimeout(deadlineTimer!);
    signal?.removeEventListener("abort", stop);
    stop();
    if (worker) await worker;
    if (gossipJob) await gossipJob;
  }
}
