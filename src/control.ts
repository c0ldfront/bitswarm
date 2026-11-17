import { enforceBudget } from "./budget.ts";
import {
  assert,
  digest,
  keyValid,
  makeEvent,
  validateManifest,
  verificationMatches,
  type Block,
  type ControlAction,
  type Event,
  type Manifest,
  type Policy,
  type ProjectionOptions,
} from "./core.ts";
import type { Store } from "./store.ts";
export type Governance = ProjectionOptions & {
  manifest: Manifest;
  planner: string;
  head: string;
  conflict: boolean;
  applied: string[];
  authorities: Map<string, string>;
  lastRevocation: Map<string, number>;
};
export function governance(manifest: Manifest, events: Event[]): Governance {
  const state: Governance = {
    manifest: structuredClone(manifest),
    planner: manifest.planner || manifest.validators[0],
    head: digest(manifest),
    conflict: false,
    applied: [],
    lastRevocation: new Map(),
    authorities: new Map([
      [digest(manifest), manifest.planner || manifest.validators[0]],
    ]),
    compacted: new Set(),
    accounted: new Map(),
    prunedAttempts: new Map(),
    cancelled: new Set(),
    dismissed: new Set(),
    resolutions: new Map(),
    checkpoints: new Map(),
    members: new Map(),
    resets: new Map(),
    epochs: new Map([[digest(manifest), 0]]),
    resetEpoch: new Map(),
  };
  const byId = new Map(events.map((e) => [e.id, e]));
  for (let n = 0; n < events.length; n++) {
    const recoveries = new Map<string, Set<string>>();
    for (const event of events)
      if (
        event.payload.kind === "recover" &&
        event.payload.parent === state.head &&
        manifest.validators.includes(event.author)
      ) {
        const choices = recoveries.get(event.author) || new Set<string>();
        choices.add(event.payload.key);
        recoveries.set(event.author, choices);
      }
    const recoveryKeys = [
      ...new Set([...recoveries.values()].flatMap((s) => [...s])),
    ];
    const successor = recoveryKeys.find(
      (key) =>
        [...recoveries.values()].filter((s) => s.size === 1 && s.has(key))
          .length >= manifest.quorum,
    );
    if (successor && successor !== state.planner) {
      state.head = digest({ recovery: state.head, planner: successor });
      state.planner = successor;
      state.authorities.set(state.head, state.planner);
      state.epochs!.set(state.head, state.epochs!.size);
      continue;
    }
    const children = events.filter(
      (e) =>
        e.payload.kind === "control" &&
        e.payload.parent === state.head &&
        e.author === state.planner,
    );
    if (!children.length) break;
    let chosen = children[0];
    if (children.length > 1) {
      const votes = new Map<string, Set<string>>();
      for (const vote of events)
        if (
          vote.payload.kind === "reconcile" &&
          vote.payload.parent === state.head &&
          manifest.validators.includes(vote.author)
        ) {
          const choices = votes.get(vote.author) || new Set<string>();
          choices.add(vote.payload.selected);
          votes.set(vote.author, choices);
        }
      const winner = children.find(
        (child) =>
          [...votes.values()].filter(
            (choices) => choices.size === 1 && choices.has(child.id),
          ).length >= manifest.quorum,
      );
      if (!winner) {
        state.conflict = true;
        break;
      }
      chosen = winner;
    }
    const e = chosen;
    if (e.payload.kind !== "control") break;
    const a = e.payload.action;
    try {
      if (a.type === "accounting") {
        for (const id of a.dropped) state.compacted!.add(id);
        for (const [author, u] of Object.entries(a.usage)) {
          const before = state.accounted!.get(author) || {
            tokens: 0,
            costMicros: 0,
          };
          state.accounted!.set(author, {
            tokens: before.tokens + u.tokens,
            costMicros: before.costMicros + u.costMicros,
          });
        }
        for (const [key, n] of Object.entries(a.attempts))
          state.prunedAttempts!.set(
            key,
            (state.prunedAttempts!.get(key) || 0) + n,
          );
      } else if (a.type === "add") {
        const p = byId.get(a.proposal);
        if (!p) break;
        assert(
          p.payload.kind === "proposal",
          "Control references a non-proposal",
        );
        const candidate = {
          ...state.manifest,
          blocks: [...state.manifest.blocks, p.payload.block],
        };
        validateManifest(candidate);
        state.manifest = candidate;
      } else if (a.type === "cancel") {
        assert(
          state.manifest.blocks.some((b) => b.id === a.block),
          "Unknown block",
        );
        state.cancelled!.add(a.block);
      } else if (a.type === "resume") {
        state.cancelled!.delete(a.block);
        state.resets!.set(a.block, e.time);
        state.resetEpoch!.set(a.block, state.epochs!.size);
      } else if (a.type === "retry") state.dismissed!.add(a.result);
      else if (a.type === "resolve") {
        assert(
          state.manifest.blocks.some((b) => b.id === a.block),
          "Unknown block",
        );
        state.resolutions!.set(a.block, a.result);
      } else if (a.type === "checkpoint") {
        if (
          !a.results.every((id) => byId.has(id)) ||
          !a.evidence.every((id) => byId.has(id))
        )
          break;
        assert(
          a.results.every((id) => byId.get(id)?.payload.kind === "result"),
          "Checkpoint must reference results",
        );
        for (const id of a.results) {
          const result = byId.get(id)!;
          if (result.payload.kind !== "result") continue;
          state.checkpoints!.set(result.payload.block, {
            result: id,
            evidence: new Set(a.evidence),
          });
        }
      } else if (a.type === "member") {
        const old = state.members!.get(a.key);
        if (old?.budget && a.budget)
          assert(
            a.budget.maxTokens >= old.budget.maxTokens &&
              a.budget.maxCostMicros >= old.budget.maxCostMicros,
            "Issued budgets cannot be reclaimed without reconciling expenditure",
          );
        const budget = a.budget || old?.budget;
        const members = new Map(state.members);
        members.set(a.key, {
          role: a.role,
          enabled: a.enabled,
          ...(budget ? { budget } : {}),
        });
        const issued = [...members.values()].reduce(
          (sum, m) => ({
            tokens: sum.tokens + (m.budget?.maxTokens ?? 0),
            cost: sum.cost + (m.budget?.maxCostMicros ?? 0),
          }),
          { tokens: 0, cost: 0 },
        );
        assert(
          issued.tokens <=
            (state.manifest.policy?.maxTokens ?? Number.MAX_SAFE_INTEGER) &&
            issued.cost <=
              (state.manifest.policy?.maxCostMicros ?? Number.MAX_SAFE_INTEGER),
          "Contributor allocations exceed project budget",
        );
        state.members = members;
        if (!a.enabled) state.lastRevocation.set(a.key, state.epochs!.size);
      } else if (a.type === "delegate") state.planner = a.key;
      else if (a.type === "policy") {
        const policy = { ...state.manifest.policy, ...a.policy };
        const issued = [...state.members!.values()].reduce(
          (s, m) => ({
            tokens: s.tokens + (m.budget?.maxTokens ?? 0),
            cost: s.cost + (m.budget?.maxCostMicros ?? 0),
          }),
          { tokens: 0, cost: 0 },
        );
        assert(
          issued.tokens <= (policy.maxTokens ?? Number.MAX_SAFE_INTEGER) &&
            issued.cost <= (policy.maxCostMicros ?? Number.MAX_SAFE_INTEGER),
          "Policy cannot invalidate issued budget allocations",
        );
        const candidate = { ...state.manifest, policy };
        validateManifest(candidate);
        state.manifest = candidate;
      }
      state.head = e.id;
      state.epochs!.set(state.head, state.epochs!.size);
      state.authorities.set(state.head, state.planner);
      state.applied.push(e.id);
    } catch {
      state.conflict = true;
      break;
    }
  }
  return state;
}
export function control(store: Store, action: ControlAction): Event {
  return store.db.transaction(() => {
    const g = store.governance();
    assert(
      !g.conflict,
      "Planner equivocation: resolve the control fork before proceeding",
    );
    assert(
      store.who.publicKey === g.planner,
      "Only the current planner may change the project",
    );
    if (action.type === "checkpoint") {
      const states = store.state();
      assert(
        action.results.every((id) => states.some((s) => s.accepted?.id === id)),
        "Checkpoint requires currently accepted results",
      );
    }
    if (action.type === "resolve")
      assert(
        store
          .state()
          .some(
            (s) =>
              s.block.id === action.block &&
              s.candidates.some(
                (c) => c.event.id === action.result && c.status === "accepted",
              ),
          ),
        "Resolution requires an approved candidate",
      );
    const event = makeEvent(store.manifest, store.who, {
      kind: "control",
      parent: g.head,
      action,
    });
    const next = governance(store.manifest, [...store.events(), event]);
    assert(
      next.head === event.id && !next.conflict,
      "Control action is invalid or references missing evidence",
    );
    if ((action.type === "member" && action.budget) || action.type === "policy")
      enforceBudget(next, store.events());
    store.addEvent(event);
    if (action.type === "checkpoint") {
      const frozen = new Set(store.state().map((state) => state.accepted?.id));
      assert(
        action.results.every((id) => frozen.has(id)),
        "Checkpoint evidence must preserve acceptance",
      );
    }
    return event;
  })();
}
export function checkpoint(store: Store) {
  const governance = store.governance();
  const results = store
    .state()
    .flatMap((s) =>
      s.accepted &&
      governance.checkpoints?.get(s.block.id)?.result !== s.accepted.id
        ? [s.accepted]
        : [],
    );
  const out: Event[] = [];
  for (const result of results) {
    if (result.payload.kind !== "result") continue;
    const id = result.payload.block;
    const block = governance.manifest.blocks.find((b) => b.id === id)!;
    const evidence = [result.id];
    for (const validator of store.manifest.validators) {
      const votes = store
        .events()
        .filter(
          (e) =>
            e.author === validator &&
            e.payload.kind === "review" &&
            e.time >= result.time &&
            e.payload.result === result.id,
        );
      if (
        new Set(
          votes.map((e) =>
            e.payload.kind === "review" ? e.payload.verdict : "",
          ),
        ).size === 1 &&
        votes[0]
      )
        evidence.push(votes[0].id);
      const check = store
        .events()
        .find(
          (e) =>
            e.author === validator &&
            e.payload.kind === "verification" &&
            e.payload.result === result.id &&
            e.payload.passed &&
            verificationMatches(e, block, result.id, store.blob.bind(store)),
        );
      if (check) evidence.push(check.id);
    }
    out.push(
      control(store, { type: "checkpoint", results: [result.id], evidence }),
    );
  }
  return out;
}
export function propose(store: Store, block: Block, reason: string): Event {
  const e = makeEvent(store.manifest, store.who, {
    kind: "proposal",
    block,
    reason,
  });
  store.addEvent(e);
  return e;
}
