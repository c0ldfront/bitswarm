import {
  assert,
  digest,
  makeEvent,
  keyValid,
  type Event,
  type CreditBlock,
  type CreditTransfer,
} from "./core.ts";
import { hasWork } from "./work.ts";
import type { Store } from "./store.ts";
type Coin = { owner: string; amount: number };
type Chain = {
  head: string;
  height: number;
  coins: Map<string, Coin>;
  minted: Set<string>;
  parent?: string;
};
function confirmedAncestor(
  head: Chain,
  states: Map<string, Chain>,
  depth: number,
): Chain {
  let ancestor = head;
  for (let n = 0; n < depth && ancestor.parent; n++)
    ancestor = states.get(ancestor.parent)!;
  return ancestor;
}
export function creditState(store: Store, additional: Event[] = []) {
  const config = store.manifest.credits;
  assert(config, "Credits are not enabled in the genesis manifest");
  const events = [...store.events(), ...additional];
  const byId = new Map(events.map((e) => [e.id, e]));
  const root = digest(store.manifest);
  const states = new Map<string, Chain>([
    [root, { head: root, height: 0, coins: new Map(), minted: new Set() }],
  ]);
  const accepted = new Map(
    store
      .state()
      .flatMap((s) =>
        s.accepted &&
        store.governance().checkpoints?.get(s.block.id)?.result ===
          s.accepted.id
          ? [[s.accepted.id, s.accepted] as const]
          : [],
      ),
  );
  const blocks = events.filter((e) => e.payload.kind === "creditblock");
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of blocks) {
      if (states.has(e.id) || e.payload.kind !== "creditblock") continue;
      const p = e.payload;
      const parent = states.get(p.parent);
      if (!parent) continue;
      try {
        assert(hasWork(unsigned(e), config.difficulty), "Invalid ledger work");
        const coins = new Map(parent.coins),
          minted = new Set(parent.minted);
        const matureInputs =
          p.transfers.length && config.confirmations
            ? confirmedAncestor(parent, states, config.confirmations).coins
            : undefined;
        let fees = 0;
        for (const id of p.transfers) {
          const transfer = byId.get(id);
          assert(
            transfer?.payload.kind === "credit-transfer",
            "Missing transfer",
          );
          const t = transfer.payload;
          let input = 0,
            output = 0;
          for (const reference of t.inputs) {
            const coin = coins.get(reference);
            assert(
              coin && coin.owner === transfer.author,
              "Missing or foreign credit input",
            );
            assert(
              !matureInputs || matureInputs.has(reference),
              "Credit input lacks confirmation depth",
            );
            input += coin.amount;
            assert(Number.isSafeInteger(input), "Credit overflow");
            coins.delete(reference);
          }
          for (const [i, coin] of t.outputs.entries()) {
            output += coin.amount;
            assert(
              Number.isSafeInteger(output) &&
                keyValid(coin.owner) &&
                coin.amount > 0,
              "Invalid output",
            );
            coins.set(transfer.id + ":" + i, coin);
          }
          assert(output <= input, "Credit overspend");
          fees += input - output;
          assert(Number.isSafeInteger(fees), "Credit fee overflow");
        }
        if (p.result) {
          const result = accepted.get(p.result);
          assert(
            result && !minted.has(p.result),
            "Reward requires a new checkpointed contribution",
          );
          minted.add(p.result);
          coins.set(e.id + ":reward", {
            owner: result.author,
            amount: config.reward,
          });
        }
        if (fees) coins.set(e.id + ":fees", { owner: e.author, amount: fees });
        states.set(e.id, {
          head: e.id,
          height: parent.height + 1,
          coins,
          minted,
          parent: parent.head,
        });
        changed = true;
      } catch {
        /* Invalid branches never contribute chain weight or spendable outputs. */
      }
    }
  }
  const ordered = [...states.values()].sort(
    (a, b) => b.height - a.height || a.head.localeCompare(b.head),
  );
  const tip = ordered[0];
  const confirmed = confirmedAncestor(tip, states, config.confirmations);
  const balances = (chain: Chain) => {
    const accounts: Record<string, number> = {};
    for (const coin of chain.coins.values())
      accounts[coin.owner] = (accounts[coin.owner] || 0) + coin.amount;
    return accounts;
  };
  return {
    tip,
    confirmed,
    balances: balances(tip),
    confirmedBalances: balances(confirmed),
    validBlocks: states.size - 1,
  };
}
export function unsigned(e: Event) {
  const { id, signature, ...body } = e;
  return body;
}
export function mineCredits(
  store: Store,
  result?: string,
  transfers: string[] = [],
  attempts = 2_000_000,
) {
  const config = store.manifest.credits;
  assert(config, "Credits disabled");
  const current = creditState(store);
  const time = Date.now(),
    nonce = crypto.randomUUID(),
    swarm = digest(store.manifest);
  const payload: CreditBlock = {
    kind: "creditblock",
    parent: current.tip.head,
    work: 0,
    transfers,
    ...(result ? { result } : {}),
  };
  for (let n = 0; n < attempts; n++) {
    payload.work = n;
    if (
      hasWork(
        {
          version: store.manifest.version,
          swarm,
          author: store.who.publicKey,
          time,
          nonce,
          payload,
        },
        config.difficulty,
      )
    ) {
      const event = makeEvent(store.manifest, store.who, payload, time, nonce);
      assert(
        creditState(store, [event]).tip.head === event.id,
        "Mined block was not eligible for the selected ledger",
      );
      store.addEvent(event);
      return event;
    }
  }
  throw new Error("Mining attempt limit reached");
}
export function transferCredits(
  store: Store,
  to: string,
  amount: number,
  fee = 0,
) {
  assert(
    keyValid(to) &&
      Number.isSafeInteger(amount) &&
      amount > 0 &&
      Number.isSafeInteger(fee) &&
      fee >= 0 &&
      Number.isSafeInteger(amount + fee),
    "Invalid credit transfer",
  );
  const state = creditState(store);
  let total = 0;
  const inputs: string[] = [];
  for (const [id, coin] of state.confirmed.coins)
    if (coin.owner === store.who.publicKey && state.tip.coins.has(id)) {
      inputs.push(id);
      total += coin.amount;
      if (total >= amount + fee) break;
    }
  assert(total >= amount + fee, "Insufficient confirmed credits");
  const outputs = [{ owner: to, amount }];
  if (total > amount + fee)
    outputs.push({ owner: store.who.publicKey, amount: total - amount - fee });
  const event = makeEvent(store.manifest, store.who, {
    kind: "credit-transfer",
    inputs,
    outputs,
  });
  store.addEvent(event);
  return event;
}
