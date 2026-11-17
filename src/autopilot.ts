import { assert, makeEvent, type Block } from "./core.ts";
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
): Promise<void> {
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
          !b.inputs.every(store.hasBlob)
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
          candidate.status === "accepted" ||
          candidate.status === "rejected" ||
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
        if (existing) continue;
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
          let attestation = store
            .events()
            .find(
              (e) =>
                e.author === store.who.publicKey &&
                e.payload.kind === "verification" &&
                e.payload.result === candidate.event.id,
            );
          if (!attestation)
            attestation = await verifyResult(
              store,
              candidate.event.id,
              command,
              config.reviewer.isolation,
              config.reviewer.image,
            );
          if (
            attestation.payload.kind === "verification" &&
            config.reviewer.autoApprove
          ) {
            store.addEvent(
              makeEvent(store.manifest, store.who, {
                kind: "review",
                result: candidate.event.id,
                verdict: attestation.payload.passed ? "approve" : "reject",
                reason:
                  "Automatic policy: locally executed pinned verifier " +
                  verifier,
              }),
            );
            journal(store, candidate.event.id, "reviewed", {
              passed: attestation.payload.passed,
            });
          }
        } catch (e) {
          journal(store, candidate.event.id, "blocked", String(e));
        }
      }
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
  assert(
    (config.pollMs ?? 500) >= 50 && (config.deadlineMs ?? 3_600_000) > 0,
    "Invalid automation timing",
  );
  const started = Date.now();
  let syncing = false;
  let gossipJob: Promise<void> | undefined;
  const gossip = () => {
    if (gossipJob) return gossipJob;
    gossipJob = (async () => {
      for (const peer of config.peers || [])
        try {
          await sync(
            store,
            peer,
            credentials(store, process.env.BITSWARM_TOKEN || ""),
          );
        } catch (e) {
          journal(store, "peer:" + peer, "offline", String(e));
        }
    })().finally(() => {
      gossipJob = undefined;
    });
    return gossipJob;
  };
  await gossip();
  const timer = setInterval(() => void gossip(), config.pollMs ?? 500);
  let worker: Promise<unknown> | undefined;
  try {
    while (!signal?.aborted) {
      assert(
        Date.now() - started < (config.deadlineMs ?? 3_600_000),
        "Automation deadline reached",
      );
      await automationStep(store, config);
      const states = store.state();
      if (
        config.stopWhenComplete &&
        states.some((s) => s.status === "exhausted")
      )
        throw new Error("Automation stopped: task attempts exhausted");
      if (
        config.stopWhenComplete &&
        (!config.goalBlocks ||
          config.goalBlocks.every((id) =>
            states.some((s) => s.block.id === id),
          )) &&
        states.every((s) => ["accepted", "cancelled"].includes(s.status))
      )
        return {
          complete: true,
          elapsedMs: Date.now() - started,
          blocks: states.length,
        };
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
          { isolation: w.isolation, image: w.image, signal },
        )
          .catch((e) => journal(store, "worker", "failed", String(e)))
          .finally(() => {
            worker = undefined;
          });
      }
      await Bun.sleep(config.pollMs ?? 500);
    }
    throw new Error("Automation stopped");
  } finally {
    clearInterval(timer);
    if (worker) await worker;
    if (gossipJob) await gossipJob;
  }
}
