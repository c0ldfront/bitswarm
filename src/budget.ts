import { assert, type Event, type Manifest } from "./core.ts";
import type { Governance } from "./control.ts";
export type Amount = { tokens: number; costMicros: number };
export function expenditure(
  manifest: Manifest,
  events: Event[],
  now = Date.now(),
): Map<string, Amount> {
  const claims = new Map(
    events.filter((e) => e.payload.kind === "claim").map((e) => [e.id, e]),
  );
  const reported = new Map<string, Amount>();
  for (const e of events) {
    const p = e.payload;
    if ((p.kind !== "result" && p.kind !== "failure") || !p.usage) continue;
    const claim = claims.get(p.claim);
    if (
      !claim ||
      claim.payload.kind !== "claim" ||
      e.author !== claim.author ||
      (p.kind === "result" && p.block !== claim.payload.block)
    )
      continue;
    const prior = reported.get(claim.id);
    reported.set(claim.id, {
      tokens: Math.max(prior?.tokens ?? 0, p.usage.tokens),
      costMicros: Math.max(prior?.costMicros ?? 0, p.usage.costMicros),
    });
  }
  const contracts = new Map(manifest.blocks.map((b) => [b.id, b.contract]));
  const totals = new Map<string, Amount>();
  for (const claim of claims.values()) {
    if (claim.payload.kind !== "claim") continue;
    const contract = contracts.get(claim.payload.block);
    // A completion without usage cannot settle the original reservation.
    const spent = reported.get(claim.id) ?? {
      tokens: contract?.maxTokens ?? 0,
      costMicros: contract?.maxCostMicros ?? 0,
    };
    const prior = totals.get(claim.author) || { tokens: 0, costMicros: 0 };
    totals.set(claim.author, {
      tokens: prior.tokens + spent.tokens,
      costMicros: prior.costMicros + spent.costMicros,
    });
  }
  return totals;
}
// Every allocated account remains committed, including revoked accounts. Legacy
// expenditure and in-flight work without an allocation consume the remainder.
export function budgetSummary(g: Governance, events: Event[]) {
  const used = expenditure(g.manifest, events);
  for (const [author, u] of g.accounted ?? []) {
    const active = used.get(author) || { tokens: 0, costMicros: 0 };
    used.set(author, {
      tokens: active.tokens + u.tokens,
      costMicros: active.costMicros + u.costMicros,
    });
  }
  const authors = new Set([...g.members!.keys(), ...used.keys()]);
  const accounts = [...authors].map((author) => {
    const allocation = g.members!.get(author)?.budget;
    const usage = used.get(author) || { tokens: 0, costMicros: 0 };
    return {
      author,
      usage,
      allocation: allocation ?? null,
      committed: {
        tokens: Math.max(allocation?.maxTokens ?? 0, usage.tokens),
        costMicros: Math.max(allocation?.maxCostMicros ?? 0, usage.costMicros),
      },
    };
  });
  const committed = accounts.reduce(
    (a, c) => ({
      tokens: a.tokens + c.committed.tokens,
      costMicros: a.costMicros + c.committed.costMicros,
    }),
    { tokens: 0, costMicros: 0 },
  );
  return {
    accounts,
    committed,
    limits: {
      tokens: g.manifest.policy?.maxTokens ?? null,
      costMicros: g.manifest.policy?.maxCostMicros ?? null,
    },
  };
}
export function enforceBudget(g: Governance, events: Event[]) {
  const report = budgetSummary(g, events);
  assert(
    report.limits.tokens === null ||
      report.committed.tokens <= report.limits.tokens,
    "Expenditure, reservations and allocations exceed project token budget",
  );
  assert(
    report.limits.costMicros === null ||
      report.committed.costMicros <= report.limits.costMicros,
    "Expenditure, reservations and allocations exceed project cost budget",
  );
  return report;
}
