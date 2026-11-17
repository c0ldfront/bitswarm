import { hasWork } from "./work.ts";
import { validContract, validateSchema } from "./contracts.ts";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

export const MAX_BLOB = 1024 * 1024;
export const MAX_EVENTS = 10_000;
export type Identity = { publicKey: string; privateKey: string };
export type Contract = {
  timeoutMs: number;
  maxAttempts: number;
  maxTokens: number;
  maxCostMicros: number;
  verifier?: string;
  verifierHash?: string;
  verificationQuorum?: number;
  schema?: Record<string, unknown>;
};
export type Policy = {
  reviewTimeoutMs?: number;
  maxConcurrent?: number;
  maxTokens?: number;
  maxCostMicros?: number;
  admission?: "open" | "invite" | "public";
  publicWorkBits?: number;
  eventQuota?: number;
  storageBytes?: number;
  uploadBytes?: number;
  requestsPerMinute?: number;
};
export type Block = {
  id: string;
  title: string;
  instructions: string;
  requires: string[];
  inputs: string[];
  optionalInputs?: string[];
  capabilities: string[];
  contract?: Contract;
};
export type Manifest = {
  version: 1 | 2 | 3 | 4;
  name: string;
  description: string;
  validators: string[];
  quorum: number;
  blocks: Block[];
  planner?: string;
  policy?: Policy;
  restricted?: boolean;
  preview?: string;
  credits?: { difficulty: number; reward: number; confirmations: number };
};
export type Claim = {
  kind: "claim";
  epoch?: string;
  block: string;
  expires: number;
  dependencies: string[];
};
export type Result = {
  kind: "result";
  block: string;
  claim: string;
  artifact: string;
  summary: string;
  usage?: { tokens: number; costMicros: number };
};
export type Review = {
  kind: "review";
  result: string;
  verdict: "approve" | "reject";
  reason: string;
};
export type ControlAction =
  | {
      type: "accounting";
      archive: string;
      dropped: string[];
      usage: Record<string, { tokens: number; costMicros: number }>;
      attempts: Record<string, number>;
    }
  | { type: "add"; proposal: string }
  | { type: "cancel"; block: string }
  | { type: "retry"; result: string }
  | { type: "resume"; block: string }
  | { type: "resolve"; block: string; result: string }
  | { type: "checkpoint"; results: string[]; evidence: string[] }
  | {
      type: "member";
      key: string;
      role: "worker" | "reviewer" | "reader";
      enabled: boolean;
      budget?: {
        maxTokens: number;
        maxCostMicros: number;
        maxConcurrent: number;
      };
    }
  | { type: "delegate"; key: string }
  | { type: "policy"; policy: Policy };
export type CreditBlock = {
  kind: "creditblock";
  parent: string;
  work: number;
  result?: string;
  transfers: string[];
};
export type CreditTransfer = {
  kind: "credit-transfer";
  inputs: string[];
  outputs: { owner: string; amount: number }[];
};
export type Payload =
  | { kind: "input-request"; block: string; root: string; reason: string }
  | CreditBlock
  | CreditTransfer
  | Claim
  | Result
  | Review
  | { kind: "recover"; parent: string; key: string }
  | { kind: "reconcile"; parent: string; selected: string }
  | { kind: "proposal"; block: Block; reason: string }
  | { kind: "control"; parent: string; action: ControlAction }
  | { kind: "renew"; claim: string; expires: number }
  | {
      kind: "failure";
      claim: string;
      reason: string;
      retryable: boolean;
      usage?: { tokens: number; costMicros: number };
    }
  | {
      kind: "verification";
      result: string;
      verifier: string;
      passed: boolean;
      report: string;
    };
export type Event = {
  version: 1 | 2 | 3 | 4;
  swarm: string;
  author: string;
  time: number;
  nonce: string;
  payload: Payload;
  signature: string;
  id: string;
};
export type Candidate = {
  event: Event;
  approvals: string[];
  rejections: string[];
  status: "pending" | "accepted" | "rejected" | "expired";
  eligible: boolean;
  verification?: "not-required" | "pending" | "passed" | "failed";
};
export type BlockState = {
  block: Block;
  status:
    | "blocked"
    | "ready"
    | "claimed"
    | "review"
    | "accepted"
    | "disputed"
    | "cancelled"
    | "exhausted";
  claims: Event[];
  candidates: Candidate[];
  accepted?: Event;
};

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  assert(
    typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === Object.prototype,
    "Expected JSON data",
  );
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export function hash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
export function digest(value: unknown): string {
  return hash(canonical(value));
}
export function identity(): Identity {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    privateKey: pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}
export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function keyValid(key: unknown): key is string {
  try {
    if (typeof key !== "string" || key.length >= 100) return false;
    const parsed = createPublicKey({
      key: Buffer.from(key, "base64"),
      type: "spki",
      format: "der",
    });
    return (
      parsed.asymmetricKeyType === "ed25519" &&
      parsed.export({ type: "spki", format: "der" }).toString("base64") === key
    );
  } catch {
    return false;
  }
}
function string(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function strings(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((v) => string(v, 200)) &&
    new Set(value).size === value.length
  );
}
export function validateManifest(m: Manifest): void {
  assert(
    m &&
      [1, 2, 3, 4].includes(m.version) &&
      string(m.name, 200) &&
      string(m.description, 10_000),
    "Invalid manifest metadata",
  );
  assert(
    Array.isArray(m.validators) &&
      m.validators.length > 0 &&
      m.validators.length <= 100 &&
      m.validators.every(keyValid) &&
      new Set(m.validators).size === m.validators.length,
    "Invalid validators",
  );
  assert(
    Number.isInteger(m.quorum) &&
      m.quorum > m.validators.length / 2 &&
      m.quorum <= m.validators.length,
    "Quorum must be a strict majority of validators",
  );
  assert(
    Array.isArray(m.blocks) && m.blocks.length > 0 && m.blocks.length <= 1000,
    "Expected 1–1000 blocks",
  );
  const ids = new Set<string>();
  for (const b of m.blocks) {
    assert(
      b && string(b.id, 100) && /^[a-zA-Z0-9_-]+$/.test(b.id) && !ids.has(b.id),
      "Invalid or duplicate block ID",
    );
    ids.add(b.id);
    assert(
      string(b.title, 200) &&
        string(b.instructions, 20_000) &&
        strings(b.requires, 1000) &&
        strings(b.inputs, 100) &&
        b.inputs.every(isHash) &&
        strings(b.capabilities, 100),
      "Invalid block",
    );
  }
  assert(!m.planner || keyValid(m.planner), "Invalid planner key");
  assert(
    m.restricted === undefined ||
      (m.version === 4 &&
        m.restricted === true &&
        m.policy?.admission === "invite"),
    "Restricted projects require protocol 4 invitations",
  );
  assert(
    m.preview === undefined || (m.version === 4 && string(m.preview, 1000)),
    "Invalid public preview",
  );
  for (const b of m.blocks)
    assert(
      b.optionalInputs === undefined ||
        (m.version === 4 &&
          strings(b.optionalInputs, 100) &&
          b.optionalInputs.every(isHash)),
      "Invalid optional inputs",
    );
  if (m.credits)
    assert(
      m.version >= 3 &&
        Number.isInteger(m.credits.difficulty) &&
        m.credits.difficulty >= 8 &&
        m.credits.difficulty <= 24 &&
        Number.isSafeInteger(m.credits.reward) &&
        m.credits.reward > 0 &&
        m.credits.reward <= Math.floor(Number.MAX_SAFE_INTEGER / 1000) &&
        Number.isInteger(m.credits.confirmations) &&
        m.credits.confirmations >= 0 &&
        m.credits.confirmations <= 100,
      "Invalid credit protocol",
    );
  if (m.policy?.admission === "public")
    assert(m.version >= 3, "Public admission requires protocol 3");
  if (m.policy) validatePolicy(m.policy);
  for (const { contract } of m.blocks) {
    if (
      contract?.verifierHash !== undefined ||
      contract?.verificationQuorum !== undefined
    ) {
      assert(
        m.version >= 3 && contract.verifier,
        "Verification settings require a named verifier and protocol 3+",
      );
      assert(
        (contract.verificationQuorum ?? m.quorum) <= m.validators.length,
        "Verification quorum exceeds validator committee",
      );
    }
  }
  for (const b of m.blocks)
    assert(!b.contract || validContract(b.contract), "Invalid task contract");
  topological(m); // Also rejects cycles and missing references.
  assert(Buffer.byteLength(canonical(m)) <= MAX_BLOB, "Manifest too large");
}
export function validatePolicy(p: Policy) {
  assert(
    p &&
      typeof p === "object" &&
      (!p.admission || ["open", "invite", "public"].includes(p.admission)),
    "Invalid admission policy",
  );
  for (const k of [
    "reviewTimeoutMs",
    "maxConcurrent",
    "maxTokens",
    "maxCostMicros",
    "eventQuota",
    "storageBytes",
    "uploadBytes",
    "requestsPerMinute",
  ] as const)
    if (p[k] !== undefined)
      assert(
        Number.isSafeInteger(p[k]) &&
          p[k]! >= 0 &&
          p[k]! <= Number.MAX_SAFE_INTEGER,
        "Invalid policy limit",
      );
  if (p.publicWorkBits !== undefined)
    assert(
      Number.isInteger(p.publicWorkBits) &&
        p.publicWorkBits >= 8 &&
        p.publicWorkBits <= 24,
      "Invalid public admission work",
    );
  assert(
    p.maxConcurrent === undefined || p.maxConcurrent > 0,
    "Concurrency must be positive",
  );
}
export function topological(m: Manifest): Block[] {
  const map = new Map(m.blocks.map((b) => [b.id, b]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const out: Block[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    assert(!visiting.has(id), "Dependency cycle");
    const b = map.get(id);
    assert(b, "Missing dependency: " + id);
    visiting.add(id);
    b.requires.forEach(visit);
    visiting.delete(id);
    visited.add(id);
    out.push(b);
  }
  m.blocks.forEach((b) => visit(b.id));
  return out;
}
export function makeEvent(
  m: Manifest,
  who: Identity,
  payload: Payload,
  time = Date.now(),
  nonce = crypto.randomUUID(),
): Event {
  const body = {
    version: m.version,
    swarm: digest(m),
    author: who.publicKey,
    time,
    nonce,
    payload,
  };
  const signature = sign(
    null,
    Buffer.from(canonical(body)),
    createPrivateKey(who.privateKey),
  ).toString("base64");
  return { ...body, signature, id: digest({ ...body, signature }) };
}
export function validateEvent(e: Event, m: Manifest, now = Date.now()): void {
  assert(
    e && e.version === m.version && e.swarm === digest(m) && keyValid(e.author),
    "Wrong swarm or identity",
  );
  assert(
    Number.isSafeInteger(e.time) &&
      e.time > 0 &&
      e.time <= now + 30_000 &&
      string(e.nonce, 100),
    "Invalid timestamp or nonce",
  );
  assert(
    typeof e.signature === "string" &&
      e.signature.length <= 100 &&
      isHash(e.id),
    "Invalid signature encoding",
  );
  const { id, signature, ...body } = e;
  assert(
    Buffer.byteLength(canonical(e)) <= 32_768 &&
      id === digest({ ...body, signature }),
    "Invalid event hash or size",
  );
  assert(
    verify(
      null,
      Buffer.from(canonical(body)),
      createPublicKey({
        key: Buffer.from(e.author, "base64"),
        type: "spki",
        format: "der",
      }),
      Buffer.from(signature, "base64"),
    ),
    "Invalid signature",
  );
  const p = e.payload;
  assert(p && typeof p === "object", "Missing payload");
  if (p.kind === "input-request")
    assert(
      m.version === 4 &&
        string(p.block, 100) &&
        isHash(p.root) &&
        string(p.reason, 512),
      "Invalid input request",
    );
  else if (p.kind === "creditblock") {
    assert(
      m.version >= 3 &&
        m.credits &&
        isHash(p.parent) &&
        Number.isSafeInteger(p.work) &&
        p.work >= 0 &&
        (!p.result || isHash(p.result)) &&
        strings(p.transfers, 100) &&
        p.transfers.every(isHash) &&
        hasWork(body, m.credits.difficulty),
      "Invalid credit proof of work",
    );
  } else if (p.kind === "credit-transfer")
    assert(
      m.version >= 3 &&
        m.credits &&
        strings(p.inputs, 100) &&
        p.inputs.length > 0 &&
        Array.isArray(p.outputs) &&
        p.outputs.length > 0 &&
        p.outputs.length <= 100 &&
        p.outputs.every(
          (o) =>
            keyValid(o.owner) && Number.isSafeInteger(o.amount) && o.amount > 0,
        ),
      "Invalid credit transfer",
    );
  else if (p.kind === "claim") {
    assert(string(p.block, 100), "Invalid block");
    if (m.version >= 2)
      assert(isHash(p.epoch), "Protocol 2+ claims require an authority epoch");
    assert(
      Number.isSafeInteger(p.expires) &&
        p.expires > e.time &&
        p.expires <= e.time + 3_600_000,
      "Lease must last at most one hour",
    );
    assert(
      strings(p.dependencies, 1000) && p.dependencies.every(isHash),
      "Invalid dependency receipts",
    );
  } else if (p.kind === "result") {
    assert(
      string(p.block, 100) &&
        isHash(p.claim) &&
        isHash(p.artifact) &&
        string(p.summary, 10_000),
      "Invalid result",
    );
  } else if (p.kind === "review") {
    assert(
      m.validators.includes(e.author) &&
        isHash(p.result) &&
        ["approve", "reject"].includes(p.verdict) &&
        string(p.reason, 10_000),
      "Invalid review or unauthorized validator",
    );
  } else if (p.kind === "recover")
    assert(
      m.validators.includes(e.author) && isHash(p.parent) && keyValid(p.key),
      "Invalid planner recovery",
    );
  else if (p.kind === "reconcile")
    assert(
      m.validators.includes(e.author) && isHash(p.parent) && isHash(p.selected),
      "Invalid reconciliation",
    );
  else if (p.kind === "proposal") {
    assert(string(p.reason, 10_000), "Invalid proposal reason");
    validateManifest({ ...m, blocks: [{ ...p.block, requires: [] }] });
    assert(strings(p.block.requires, 1000), "Invalid proposal dependencies");
  } else if (p.kind === "control") {
    assert(
      isHash(p.parent) && p.action && typeof p.action === "object",
      "Invalid control event",
    );
    const a = p.action;
    if (a.type === "accounting") {
      assert(
        m.version >= 3 &&
          isHash(a.archive) &&
          strings(a.dropped, 256) &&
          a.dropped.every(isHash) &&
          a.usage &&
          a.attempts,
        "Invalid compaction",
      );
      for (const [key, value] of Object.entries(a.usage))
        assert(
          keyValid(key) &&
            Number.isSafeInteger(value.tokens) &&
            value.tokens >= 0 &&
            Number.isSafeInteger(value.costMicros) &&
            value.costMicros >= 0,
          "Invalid compacted usage",
        );
      for (const [key, value] of Object.entries(a.attempts))
        assert(
          key.length <= 200 && Number.isSafeInteger(value) && value >= 0,
          "Invalid compacted attempts",
        );
    } else if (a.type === "add")
      assert(isHash(a.proposal), "Invalid proposal reference");
    else if (a.type === "cancel" || a.type === "resume")
      assert(string(a.block, 100), "Invalid block");
    else if (a.type === "retry") assert(isHash(a.result), "Invalid result");
    else if (a.type === "resolve")
      assert(string(a.block, 100) && isHash(a.result), "Invalid resolution");
    else if (a.type === "checkpoint")
      assert(
        strings(a.results, 1000) &&
          a.results.every(isHash) &&
          strings(a.evidence, 10000) &&
          a.evidence.every(isHash),
        "Invalid checkpoint",
      );
    else if (a.type === "member") {
      assert(
        keyValid(a.key) &&
          ["worker", "reviewer", "reader"].includes(a.role) &&
          typeof a.enabled === "boolean",
        "Invalid member",
      );
      if (a.budget) validatePolicy(a.budget);
    } else if (a.type === "delegate")
      assert(keyValid(a.key), "Invalid planner");
    else if (a.type === "policy") validatePolicy(a.policy);
    else throw new Error("Unknown control action");
  } else if (p.kind === "renew")
    assert(
      isHash(p.claim) &&
        Number.isSafeInteger(p.expires) &&
        p.expires > e.time &&
        p.expires <= e.time + 3_600_000,
      "Invalid renewal",
    );
  else if (p.kind === "failure")
    assert(
      isHash(p.claim) &&
        string(p.reason, 10_000) &&
        typeof p.retryable === "boolean",
      "Invalid failure",
    );
  else if (p.kind === "verification")
    assert(
      m.validators.includes(e.author) &&
        isHash(p.result) &&
        isHash(p.report) &&
        string(p.verifier, 100) &&
        typeof p.passed === "boolean",
      "Invalid verification",
    );
  else throw new Error("Unknown event kind");
  if ((p.kind === "result" || p.kind === "failure") && p.usage)
    assert(
      Number.isSafeInteger(p.usage.tokens) &&
        p.usage.tokens >= 0 &&
        Number.isSafeInteger(p.usage.costMicros) &&
        p.usage.costMicros >= 0,
      "Invalid usage",
    );
}

// Pure projection of an unordered event set. A partition may create duplicate work;
// claims are advisory, and conflicting accepted artifacts explicitly halt dependents.
export function claimExpiration(
  claim: Event,
  events: Event[],
  duration = 3_600_000,
): number {
  if (claim.payload.kind !== "claim") return 0;
  let expiry = Math.min(claim.payload.expires, claim.time + duration);
  const renewals = events
    .filter(
      (e) =>
        e.payload.kind === "renew" &&
        e.payload.claim === claim.id &&
        e.author === claim.author &&
        e.time >= claim.time,
    )
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  for (const renewal of renewals)
    if (renewal.time <= expiry && renewal.payload.kind === "renew")
      expiry = Math.max(
        expiry,
        Math.min(renewal.payload.expires, claim.time + duration),
      );
  return expiry;
}
// Local attestation, replicated projection, and checkpoint selection share the same evidence rules.
export function validVerificationChecks(
  value: unknown,
): value is { passed: boolean; checks: { passed: boolean }[] } {
  if (
    !value ||
    typeof value !== "object" ||
    !("passed" in value) ||
    typeof value.passed !== "boolean" ||
    !("checks" in value) ||
    !Array.isArray(value.checks) ||
    !value.checks.length
  )
    return false;
  return (
    value.checks.every((check) => check && typeof check.passed === "boolean") &&
    value.passed === value.checks.every((check) => check.passed)
  );
}
export function verificationMatches(
  event: Event,
  block: Block,
  resultId: string,
  readBlob: (id: string) => Uint8Array | undefined,
  expectedRecipe?: string,
): boolean {
  const evidence = event.payload,
    contract = block.contract;
  if (
    evidence.kind !== "verification" ||
    evidence.result !== resultId ||
    !contract?.verifier ||
    evidence.verifier !== contract.verifier
  )
    return false;
  const bytes = readBlob(evidence.report);
  if (!bytes) return false;
  try {
    const report = JSON.parse(Buffer.from(bytes).toString());
    return (
      report?.result === resultId &&
      report.verifier === contract.verifier &&
      (!contract.verifierHash || report.recipe === contract.verifierHash) &&
      (!expectedRecipe || report.recipe === expectedRecipe) &&
      validVerificationChecks(report.checks) &&
      report.checks.passed === evidence.passed
    );
  } catch {
    return false;
  }
}
export type ProjectionOptions = {
  cancelled?: Set<string>;
  dismissed?: Set<string>;
  resolutions?: Map<string, string>;
  checkpoints?: Map<string, { result: string; evidence: Set<string> }>;
  members?: Map<
    string,
    {
      role: string;
      enabled: boolean;
      budget?: {
        maxTokens: number;
        maxCostMicros: number;
        maxConcurrent: number;
      };
    }
  >;
  resets?: Map<string, number>;
  compacted?: Set<string>;
  accounted?: Map<string, { tokens: number; costMicros: number }>;
  prunedAttempts?: Map<string, number>;
  epochs?: Map<string, number>;
  resetEpoch?: Map<string, number>;
  authorities?: Map<string, string>;
  readBlob?: (id: string) => Uint8Array | undefined;
};
export function project(
  m: Manifest,
  events: Event[],
  hasBlob: (id: string) => boolean,
  now = Date.now(),
  options: ProjectionOptions = {},
): BlockState[] {
  const all = [...new Map(events.map((e) => [e.id, e])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const byId = new Map(all.map((e) => [e.id, e]));
  const states = new Map<string, BlockState>();
  for (const block of topological(m)) {
    const checkpoint = options.checkpoints?.get(block.id);
    const dependencies = block.requires.map((id) => states.get(id)!);
    const ready = dependencies.every((s) => s.status === "accepted");
    const inputsAvailable = block.inputs.every((id) => {
      if (!hasBlob(id)) return false;
      if (!options.readBlob) return true;
      try {
        const index = JSON.parse(Buffer.from(options.readBlob(id)!).toString());
        return (
          index.type !== "bitswarm.file.v1" ||
          (Array.isArray(index.chunks) &&
            index.chunks.every((id: unknown) => isHash(id) && hasBlob(id)))
        );
      } catch {
        return true;
      }
    });
    function claimEligible(e: Event): boolean {
      if (e.payload.kind !== "claim" || e.payload.block !== block.id || !ready)
        return false;
      const planner =
        (e.payload.epoch && options.authorities?.get(e.payload.epoch)) ||
        m.planner ||
        m.validators[0];
      const frozen =
        checkpoint &&
        byId.get(checkpoint.result)?.payload.kind === "result" &&
        (byId.get(checkpoint.result)!.payload as Result).claim === e.id;
      if (
        !frozen &&
        (options.members?.get(e.author)?.enabled === false ||
          options.members?.get(e.author)?.role === "reader" ||
          (m.policy?.admission === "invite" &&
            !options.members?.get(e.author)?.enabled &&
            !m.validators.includes(e.author) &&
            e.author !== planner))
      )
        return false;
      if (
        m.version >= 2 &&
        (!e.payload.epoch || !options.epochs?.has(e.payload.epoch))
      )
        return false;
      const refs = e.payload.dependencies;
      return (
        refs.length === dependencies.length &&
        dependencies.every((s) =>
          refs.some((id) => {
            const candidate = s.candidates.find((c) => c.event.id === id);
            return (
              candidate?.status === "accepted" &&
              candidate.eligible &&
              candidate.event.payload.kind === "result" &&
              s.accepted?.payload.kind === "result" &&
              candidate.event.payload.artifact === s.accepted.payload.artifact
            );
          }),
        )
      );
    }
    function expiry(e: Event) {
      return claimExpiration(e, all, block.contract?.timeoutMs);
    }
    const failed = new Set(
      all
        .filter(
          (e) =>
            e.payload.kind === "failure" &&
            byId.get(e.payload.claim)?.author === e.author,
        )
        .map((e) => (e.payload as { claim: string }).claim),
    );
    const candidates: Candidate[] = all
      .filter(
        (e) => e.payload.kind === "result" && e.payload.block === block.id,
      )
      .map((event) => {
        const p = event.payload as Result;
        const claim = byId.get(p.claim);
        let eligible =
          !!claim &&
          claim.payload.kind === "claim" &&
          claimEligible(claim) &&
          claim.author === event.author &&
          event.time >= claim.time &&
          event.time <= expiry(claim) &&
          hasBlob(p.artifact) &&
          !options.dismissed?.has(event.id);
        if (block.contract?.schema) {
          try {
            eligible =
              eligible &&
              !!options.readBlob &&
              validateSchema(
                block.contract.schema,
                JSON.parse(
                  Buffer.from(options.readBlob!(p.artifact)!).toString(),
                ),
              );
          } catch {
            eligible = false;
          }
        }
        const verifications = all.filter(
          (e) =>
            e.payload.kind === "verification" &&
            e.author !== event.author &&
            m.validators.includes(e.author) &&
            (!checkpoint || checkpoint.evidence.has(e.id)) &&
            !!options.readBlob &&
            verificationMatches(e, block, event.id, options.readBlob),
        );
        const verifierFailed = verifications.some(
          (e) => e.payload.kind === "verification" && !e.payload.passed,
        );
        const verifiedAuthors = new Set(
          verifications
            .filter(
              (e) => e.payload.kind === "verification" && e.payload.passed,
            )
            .map((e) => e.author),
        );
        const verified =
          !block.contract?.verifier ||
          verifiedAuthors.size >=
            (block.contract.verificationQuorum ??
              (m.version >= 3 ? m.quorum : 1));
        if (block.contract)
          eligible =
            eligible &&
            !!p.usage &&
            p.usage.tokens <= block.contract.maxTokens &&
            p.usage.costMicros <= block.contract.maxCostMicros;
        const approvals: string[] = [];
        const rejections: string[] = [];
        for (const validator of m.validators) {
          if (validator === event.author) continue;
          const votes = all.filter(
            (e) =>
              (!checkpoint || checkpoint.evidence.has(e.id)) &&
              e.author === validator &&
              e.time >= event.time &&
              e.payload.kind === "review" &&
              e.payload.result === event.id,
          );
          const verdicts = new Set(
            votes.map((e) => (e.payload as Review).verdict),
          );
          // An equivocating validator contributes neither vote.
          if (verdicts.size === 1)
            (verdicts.has("approve") ? approvals : rejections).push(validator);
        }
        const expired =
          !checkpoint &&
          now > event.time + (m.policy?.reviewTimeoutMs ?? 86_400_000);
        return {
          event,
          eligible,
          approvals,
          rejections,
          verification: !block.contract?.verifier
            ? "not-required"
            : verifierFailed
              ? "failed"
              : verified
                ? "passed"
                : "pending",
          status:
            eligible && (verifierFailed || rejections.length >= m.quorum)
              ? "rejected"
              : eligible && verified && approvals.length >= m.quorum
                ? "accepted"
                : expired
                  ? "expired"
                  : "pending",
        };
      });
    const selection = checkpoint?.result || options.resolutions?.get(block.id);
    const accepted = candidates.filter(
      (c) =>
        c.status === "accepted" &&
        c.eligible &&
        (!selection || c.event.id === selection),
    );
    const artifacts = new Set(
      accepted.map((c) => (c.event.payload as Result).artifact),
    );
    const claims = all.filter(
      (e) =>
        e.payload.kind === "claim" &&
        e.payload.block === block.id &&
        expiry(e) > now &&
        !failed.has(e.id) &&
        claimEligible(e) &&
        !candidates.some(
          (c) => c.eligible && (c.event.payload as Result).claim === e.id,
        ),
    );
    const reset = options.resetEpoch?.get(block.id);
    function countsAttempt(epoch: string | undefined) {
      if (!epoch) return m.version === 1 && reset === undefined;
      const index = options.epochs?.get(epoch);
      if (m.version === 1 && reset === undefined) return true;
      return index !== undefined && (reset === undefined || index >= reset);
    }
    const attempts = all.filter(
      (e) =>
        e.payload.kind === "claim" &&
        e.payload.block === block.id &&
        countsAttempt(e.payload.epoch),
    ).length;
    const priorAttempts = [...(options.prunedAttempts ?? [])]
      .filter(([key]) => {
        const [id, epoch] = key.split("#");
        return (
          id === block.id &&
          countsAttempt(epoch === "legacy" ? undefined : epoch)
        );
      })
      .reduce((s, [, n]) => s + n, 0);
    const exhausted =
      attempts + priorAttempts >= (block.contract?.maxAttempts ?? 100);
    const status = options.cancelled?.has(block.id)
      ? "cancelled"
      : !ready
        ? "blocked"
        : artifacts.size > 1
          ? "disputed"
          : artifacts.size === 1
            ? "accepted"
            : candidates.some((c) => c.eligible && c.status === "pending")
              ? "review"
              : claims.length
                ? "claimed"
                : !inputsAvailable
                  ? "blocked"
                  : exhausted
                    ? "exhausted"
                    : "ready";
    states.set(block.id, {
      block,
      status,
      claims,
      candidates,
      ...(status === "accepted" ? { accepted: accepted[0].event } : {}),
    });
  }
  return [...states.values()];
}
