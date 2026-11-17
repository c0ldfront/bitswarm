import { hydrateTask } from "./network.ts";
import { propose } from "./control.ts";
import { prepareAdapter } from "./adapter.ts";
import { enforceBudget } from "./budget.ts";
import {
  assert,
  claimExpiration,
  makeEvent,
  verificationMatches,
  hash,
  type BlockState,
  type Event,
  type Claim,
  type Result,
} from "./core.ts";
import { validateSchema } from "./contracts.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  execute,
  ExecutionError,
  workspace,
  type Isolation,
} from "./runtime.ts";
import { Store } from "./store.ts";

class TaskBudgetUnavailable extends Error {}
class TaskUnavailable extends Error {}

export async function prepareTask(
  store: Store,
  id: string,
  signal?: AbortSignal,
  peers?: string[],
) {
  signal?.throwIfAborted();
  const profile = store.participation();
  if (!profile) return;
  assert(
    profile.download !== "metadata",
    "Metadata observer: choose --download tasks to work",
  );
  assert(
    !profile.only || profile.only.includes(id),
    "Task outside local selection",
  );
  const block = store.governance().manifest.blocks.find((b) => b.id === id);
  assert(block, "Unknown task");
  checkReservation(store, block.contract);
  await hydrateTask(
    store,
    id,
    () =>
      store.state().some((s) => s.block.id === id && s.status === "ready") &&
      [...store.expandRoots(store.taskInputs(block))].every(store.hasBlob),
    signal,
    peers,
  );
}
export function requestInput(
  store: Store,
  blockId: string,
  root: string,
  reason: string,
) {
  const block = store
    .governance()
    .manifest.blocks.find((b) => b.id === blockId);
  assert(
    block?.optionalInputs?.includes(root),
    "Input was not offered by the project for this task",
  );
  const event = makeEvent(store.manifest, store.who, {
    kind: "input-request",
    block: blockId,
    root,
    reason,
  });
  store.addEvent(event);
  return event;
}
function checkReservation(
  store: Store,
  budget: BlockState["block"]["contract"],
) {
  const g = store.governance(),
    member = g.members!.get(store.who.publicKey);
  const policy = { ...g.manifest.policy, ...member?.budget };
  if (!member?.budget && policy.maxTokens !== undefined) policy.maxTokens = 0;
  if (!member?.budget && policy.maxCostMicros !== undefined)
    policy.maxCostMicros = 0;
  const usage = store.usage();

  if (
    !budget &&
    (policy.maxTokens !== undefined || policy.maxCostMicros !== undefined)
  )
    throw new TaskBudgetUnavailable("Budgeted projects require task contracts");
  if (
    usage.tokens + (budget?.maxTokens ?? 0) >
    (policy.maxTokens ?? Number.MAX_SAFE_INTEGER)
  )
    throw new TaskBudgetUnavailable("Local token budget exhausted");
  if (
    usage.costMicros + (budget?.maxCostMicros ?? 0) >
    (policy.maxCostMicros ?? Number.MAX_SAFE_INTEGER)
  )
    throw new TaskBudgetUnavailable("Local cost budget exhausted");
  return policy;
}
export function claim(store: Store, blockId: string, ttl = 300_000) {
  return store.db
    .transaction(() => {
      const profile = store.participation();
      assert(
        profile?.download !== "metadata" &&
          (!profile?.only || profile.only.includes(blockId)),
        "Block outside local participation scope",
      );
      if (profile?.download === "tasks") store.subscribe(blockId);
      const g = store.governance();
      assert(!g.conflict, "Planner control fork blocks new work");
      const states = store.state();
      const state = states.find((s) => s.block.id === blockId);
      if (state?.status !== "ready")
        throw new TaskUnavailable("Block is not ready or is already claimed");
      if (
        ![...store.expandRoots(store.taskInputs(state.block))].every(
          store.hasBlob,
        )
      )
        throw new TaskUnavailable("Task input is unavailable");
      const member = g.members!.get(store.who.publicKey);
      assert(
        member?.enabled !== false && (!member || member.role === "worker"),
        "Worker membership required",
      );
      assert(
        g.manifest.policy?.admission !== "invite" ||
          member?.enabled ||
          store.who.publicKey === g.planner ||
          store.manifest.validators.includes(store.who.publicKey),
        "Worker invitation required",
      );
      const budget = state.block.contract;
      const policy = checkReservation(store, budget);
      const live = states
        .flatMap((s) => s.claims)
        .filter((e) => e.author === store.who.publicKey).length;
      assert(
        live < (policy.maxConcurrent ?? 4),
        "Local concurrency budget exhausted",
      );
      const dependencies = state.block.requires.map(
        (id) => states.find((s) => s.block.id === id)!.accepted!.id,
      );
      const event = makeEvent(store.manifest, store.who, {
        kind: "claim",
        epoch: g.head,
        block: blockId,
        expires: Date.now() + Math.min(ttl, budget?.timeoutMs ?? ttl),
        dependencies,
      });
      enforceBudget(g, [...store.events(), event]);
      store.addEvent(event);
      return event;
    })
    .immediate();
}
export function submit(
  store: Store,
  claimId: string,
  artifact: Uint8Array,
  summary: string,
  usage = { tokens: 0, costMicros: 0 },
) {
  return store.db
    .transaction(() => {
      const lease = store.event(claimId);
      assert(
        lease?.payload.kind === "claim" && lease.author === store.who.publicKey,
        "Missing or foreign claim",
      );
      const events = store.events();
      const existing = events.filter(
        (e) =>
          e.author === lease.author &&
          e.payload.kind === "result" &&
          e.payload.claim === lease.id,
      );
      if (existing.length) {
        const artifactId = hash(artifact);
        const identical = existing.find(
          (e) =>
            e.payload.kind === "result" &&
            e.payload.artifact === artifactId &&
            e.payload.summary === summary &&
            (e.payload.usage?.tokens ?? 0) === usage.tokens &&
            (e.payload.usage?.costMicros ?? 0) === usage.costMicros,
        );
        assert(identical, "Claim already has a different result");
        return identical;
      }
      const g = store.governance();
      assert(!g.conflict, "Planner control fork blocks publication");
      const state = store
        .state()
        .find((s) => s.block.id === (lease.payload as Claim).block);
      const contract = state?.block.contract;
      assert(
        claimExpiration(lease, events, contract?.timeoutMs) > Date.now(),
        "Expired claim",
      );
      const member = g.members!.get(store.who.publicKey);
      assert(
        member?.enabled !== false && (!member || member.role === "worker"),
        "Worker membership required",
      );
      assert(
        state &&
          ["claimed", "review"].includes(state.status) &&
          state.claims.some((c) => c.id === lease.id),
        "Claim is no longer active for this task",
      );
      if (contract) {
        assert(
          usage.tokens <= contract.maxTokens &&
            usage.costMicros <= contract.maxCostMicros,
          "Result exceeds task budget",
        );
        if (contract.schema)
          assert(
            validateSchema(
              contract.schema,
              JSON.parse(Buffer.from(artifact).toString()),
            ),
            "Result violates task output schema",
          );
      }
      const artifactId = store.addBlob(artifact);
      const event = makeEvent(store.manifest, store.who, {
        kind: "result",
        block: lease.payload.block,
        claim: lease.id,
        artifact: artifactId,
        summary,
        usage,
      });
      enforceBudget(store.governance(), [...store.events(), event]);
      store.addEvent(event);
      return event;
    })
    .immediate();
}
export function packet(store: Store, claimId: string) {
  const lease = store.event(claimId);
  assert(lease?.payload.kind === "claim", "Unknown claim");
  const p = lease.payload as Claim;
  const m = store.governance().manifest;
  const block = m.blocks.find((b) => b.id === p.block)!;
  const read = (id: string) => {
    const data = store.blob(id);
    assert(data, "Missing input artifact");
    return {
      id,
      encoding: "base64",
      data: Buffer.from(data).toString("base64"),
    };
  };
  return {
    protocol: "bitswarm.adapter.v1",
    swarm: lease.swarm,
    claim: lease.id,
    deadline: p.expires,
    project: { name: m.name, description: m.description },
    block,
    inputs: block.inputs.map(read),
    sources: store.taskInputs(block).map(read),
    dependencies: p.dependencies.map((id) => {
      const e = store.event(id)!;
      const r = e.payload as Result;
      return {
        block: r.block,
        result: id,
        summary: r.summary,
        artifact: read(r.artifact),
      };
    }),
    previous: store
      .state()
      .find((s) => s.block.id === p.block)
      ?.candidates.filter((c) => c.status === "rejected")
      .slice(-3)
      .map((c) => ({
        result: c.event.id,
        summary:
          c.event.payload.kind === "result" ? c.event.payload.summary : "",
        reports: store.events().flatMap((e) => {
          if (
            e.payload.kind !== "verification" ||
            !verificationMatches(e, block, c.event.id, (id) => store.blob(id))
          )
            return [];
          return [
            JSON.parse(Buffer.from(store.blob(e.payload.report)!).toString()),
          ];
        }),
      })),
    output: {
      summary: "Findings and limits",
      artifact:
        "JSON with findings, evidence, generated files and unresolved questions",
      usage: { tokens: 0, costMicros: 0 },
    },
  };
}
export async function runWorker(
  store: Store,
  command: string[],
  capabilities: string[] = [],
  ttl = 300_000,
  options: {
    isolation?: Isolation;
    image?: string;
    signal?: AbortSignal;
    peers?: string[];
  } = {},
) {
  assert(command.length, "Provide an adapter executable after --");
  options.signal?.throwIfAborted();
  const profile = store.participation();
  if (profile?.download === "metadata") return undefined;
  const candidates = store
    .state()
    .filter(
      (s) =>
        (!profile?.only || profile.only.includes(s.block.id)) &&
        s.block.capabilities.every((c) => capabilities.includes(c)) &&
        (s.status === "ready" ||
          (profile &&
            s.status === "blocked" &&
            !store.governance().cancelled?.has(s.block.id) &&
            s.block.requires.every((id) =>
              store
                .events()
                .some(
                  (e) => e.payload.kind === "result" && e.payload.block === id,
                ),
            ))),
    );
  let chosen: { state: BlockState; lease: Event } | undefined;
  let budgetError: TaskBudgetUnavailable | undefined;
  for (const state of candidates) {
    try {
      await prepareTask(store, state.block.id, options.signal, options.peers);
      options.signal?.throwIfAborted();
      chosen = { state, lease: claim(store, state.block.id, ttl) };
      break;
    } catch (error) {
      if (error instanceof TaskBudgetUnavailable) budgetError ??= error;
      else if (!(error instanceof TaskUnavailable)) throw error;
    }
  }
  if (!chosen) {
    if (budgetError) throw budgetError;
    return undefined;
  }
  const { state: next, lease } = chosen;
  let work: ReturnType<typeof workspace> | undefined;
  const executionTimeout = next.block.contract?.timeoutMs ?? ttl;
  const cancellation = new AbortController();
  const stop = () => cancellation.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", stop, { once: true });
  let observed = store.events().length;
  const monitor = setInterval(() => {
    try {
      const count = (
        store.db.query("SELECT COUNT(*) AS n FROM events").get() as {
          n: number;
        }
      ).n;
      if (count === observed) return;
      observed = count;
      const g = store.governance();
      const state = store.state().find((s) => s.block.id === next.block.id);
      if (
        g.conflict ||
        !state ||
        !["claimed", "review"].includes(state.status) ||
        !state.claims.some((c) => c.id === lease.id) ||
        (g.members?.has(store.who.publicKey) &&
          g.members.get(store.who.publicKey)?.role !== "worker")
      )
        cancellation.abort(
          new Error(
            "Task cancelled, completed, invalidated or contributor revoked",
          ),
        );
    } catch (e) {
      cancellation.abort(e);
    }
  }, 50);
  const heartbeat = setInterval(
    () => {
      try {
        store.addEvent(
          makeEvent(store.manifest, store.who, {
            kind: "renew",
            claim: lease.id,
            expires: Math.min(Date.now() + ttl, lease.time + executionTimeout),
          }),
        );
      } catch {}
    },
    Math.max(500, Math.floor(ttl / 3)),
  );
  try {
    const input = packet(store, lease.id);
    work = workspace(
      store,
      input.sources.map((s) => s.id),
    );
    const invoke = async () =>
      JSON.parse(
        (
          await execute({
            command: await prepareAdapter(
              command,
              work!.path,
              options.isolation,
            ),
            cwd: work!.path,
            signal: cancellation.signal,
            input: {
              ...input,
              deadline: lease.time + executionTimeout,
              workspace: work!.path,
              files: work!.files,
            },
            timeoutMs: Math.max(
              1,
              lease.time + executionTimeout - Date.now() - 1000,
            ),
            forwardProvider: true,
            isolation: options.isolation,
            image: options.image,
          })
        ).stdout,
      );
    let response = await invoke();
    // An optional input costs an extra adapter turn. Include that turn in the receipt.
    if (response.needInput) {
      const partial = response.usage;
      assert(
        partial &&
          Number.isSafeInteger(partial.tokens) &&
          partial.tokens >= 0 &&
          Number.isSafeInteger(partial.costMicros) &&
          partial.costMicros >= 0,
        "Input request must report usage",
      );
      const contract = next.block.contract;
      assert(
        contract &&
          partial.tokens <= contract.maxTokens &&
          partial.costMicros <= contract.maxCostMicros,
        "Input request exhausted budget",
      );
      requestInput(
        store,
        next.block.id,
        response.needInput.root,
        response.needInput.reason,
      );
      const root = response.needInput.root;
      await hydrateTask(
        store,
        next.block.id,
        () => [...store.expandRoots([root])].every(store.hasBlob),
        cancellation.signal,
        options.peers,
      );
      assert(
        [...store.expandRoots([root])].every(store.hasBlob),
        "Requested input unavailable",
      );
      work.cleanup();
      const refreshed = packet(store, lease.id);
      refreshed.block = {
        ...refreshed.block,
        contract: {
          ...contract,
          maxTokens: contract.maxTokens - partial.tokens,
          maxCostMicros: contract.maxCostMicros - partial.costMicros,
        },
      };
      Object.assign(input, refreshed);
      work = workspace(
        store,
        input.sources.map((s) => s.id),
      );
      response = await invoke();
      assert(
        !response.needInput && response.usage,
        "One extra input request per attempt",
      );
      assert(
        Number.isSafeInteger(response.usage.tokens) &&
          response.usage.tokens >= 0 &&
          Number.isSafeInteger(response.usage.costMicros) &&
          response.usage.costMicros >= 0,
        "Invalid follow-up usage",
      );
      response.usage = {
        tokens: partial.tokens + response.usage.tokens,
        costMicros: partial.costMicros + response.usage.costMicros,
      };
    }
    assert(
      response &&
        typeof response.summary === "string" &&
        response.artifact !== undefined,
      "Adapter must return {summary,artifact} JSON",
    );
    if (Array.isArray(response.proposals))
      assert(
        response.proposals.length <= 8,
        "At most 8 follow-up proposals per task",
      );
    if (
      next.block.contract &&
      (next.block.contract.maxTokens > 0 ||
        next.block.contract.maxCostMicros > 0)
    )
      assert(
        response.usage &&
          Number.isSafeInteger(response.usage.tokens) &&
          response.usage.tokens >= 0 &&
          Number.isSafeInteger(response.usage.costMicros) &&
          response.usage.costMicros >= 0,
        "Budgeted adapter must report usage",
      );
    cancellation.signal.throwIfAborted();
    const submitted = submit(
      store,
      lease.id,
      Buffer.from(JSON.stringify(response.artifact)),
      response.summary,
      response.usage,
    );
    if (Array.isArray(response.proposals)) {
      for (const p of response.proposals)
        try {
          propose(store, p.block, p.reason);
        } catch (e) {
          console.error("Proposal rejected: " + String(e));
        }
    }
    return submitted;
  } catch (error) {
    if (error instanceof ExecutionError && error.stderr) {
      const dir = join(store.directory, "failures");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      let diagnostic = error.stderr;
      for (const [key, value] of Object.entries(process.env))
        if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && value && value.length > 8)
          diagnostic = diagnostic.split(value).join("[REDACTED]");
      writeFileSync(join(dir, lease.id + ".log"), diagnostic, { mode: 0o600 });
    }
    store.db
      .transaction(() => {
        const closed = store
          .events()
          .some(
            (e) =>
              e.author === lease.author &&
              (e.payload.kind === "result" || e.payload.kind === "failure") &&
              e.payload.claim === lease.id,
          );
        if (closed || !store.event(lease.id)) return;
        store.addEvent(
          makeEvent(store.manifest, store.who, {
            kind: "failure",
            claim: lease.id,
            reason: (error instanceof Error && error.message
              ? error.message
              : "Execution failed"
            ).slice(0, 1024),
            retryable: true,
            usage: {
              tokens: next.block.contract?.maxTokens ?? 0,
              costMicros: next.block.contract?.maxCostMicros ?? 0,
            },
          }),
        );
      })
      .immediate();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", stop);
    clearInterval(heartbeat);
    clearInterval(monitor);
    work?.cleanup();
  }
}
