import { hasWork } from "./work.ts";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  canonical,
  digest,
  hash,
  keyValid,
  type Identity,
} from "./core.ts";
import type { Store } from "./store.ts";
export type Grant = {
  version: 1;
  swarm: string;
  issuer: string;
  authority: string;
  subject: string;
  role: "worker" | "reviewer" | "reader";
  expires: number;
  nonce: string;
  blocks?: string[];
  roots?: string[];
  signature: string;
};
export type Auth =
  | string
  | {
      identity: Identity;
      grant?: Grant;
      token?: string;
      powBits?: number;
      swarm?: string;
    };
export function signature(value: unknown, identity: Identity) {
  return sign(
    null,
    Buffer.from(canonical(value)),
    createPrivateKey(identity.privateKey),
  ).toString("base64");
}
export function verifies(value: unknown, sig: string, key: string): boolean {
  try {
    return (
      keyValid(key) &&
      verify(
        null,
        Buffer.from(canonical(value)),
        createPublicKey({
          key: Buffer.from(key, "base64"),
          type: "spki",
          format: "der",
        }),
        Buffer.from(sig, "base64"),
      )
    );
  } catch {
    return false;
  }
}
export function grant(
  store: Store,
  subject: string,
  role: Grant["role"],
  expires: number,
  scope?: { blocks: string[]; roots: string[] },
): Grant {
  assert(
    store.governance().planner === store.who.publicKey,
    "Only planner may invite contributors",
  );
  assert(keyValid(subject), "Invalid contributor key");
  assert(
    expires > Date.now() && expires <= Date.now() + 30 * 86_400_000,
    "Invitation must expire within 30 days",
  );
  if (scope) {
    assert(
      store.manifest.restricted &&
        scope.blocks.length <= 64 &&
        scope.roots.length <= 64 &&
        scope.blocks.every((id) =>
          store.governance().manifest.blocks.some((b) => b.id === id),
        ) &&
        scope.roots.every((id) => /^[a-f0-9]{64}$/.test(id)),
      "Invalid read grant scope",
    );
  }
  const body = {
    ...scope,
    version: 1 as const,
    swarm: digest(store.manifest),
    issuer: store.who.publicKey,
    authority: store.governance().head,
    subject,
    role,
    expires,
    nonce: crypto.randomUUID(),
  };
  return { ...body, signature: signature(body, store.who) };
}
export function credentials(store: Store, token = ""): Auth {
  const path = join(store.directory, "access.json");
  return !store.manifest.restricted &&
    store.governance().manifest.policy?.admission === "public"
    ? {
        identity: store.who,
        swarm: digest(store.manifest),
        powBits: store.governance().manifest.policy?.publicWorkBits ?? 12,
      }
    : store.manifest.restricted ||
        store.governance().manifest.policy?.admission === "invite" ||
        existsSync(path)
      ? {
          identity: store.who,
          swarm: digest(store.manifest),
          grant: existsSync(path)
            ? JSON.parse(readFileSync(path, "utf8"))
            : undefined,
        }
      : { identity: store.who, token };
}
export function authHeaders(
  auth: Auth,
  method: string,
  path: string,
  bytes: Uint8Array,
): Record<string, string> {
  if (typeof auth !== "string" && auth.token !== undefined)
    return { authorization: "Bearer " + auth.token };
  if (typeof auth === "string") return { authorization: "Bearer " + auth };
  const body = {
    author: auth.identity.publicKey,
    swarm: auth.swarm ?? auth.grant?.swarm ?? null,
    method,
    path,
    hash: hash(bytes),
    time: Date.now(),
    nonce: crypto.randomUUID(),
    grant: auth.grant ?? null,
    work: 0,
  };
  if (auth.powBits !== undefined) {
    assert(
      Number.isInteger(auth.powBits) && auth.powBits >= 8 && auth.powBits <= 24,
      "Invalid admission work difficulty",
    );
    const started = Date.now();
    while (!hasWork(body, auth.powBits)) {
      body.work++;
      if (body.work % 1024 === 0)
        assert(
          Date.now() - started < 5000,
          "Admission work time budget exceeded",
        );
      if (body.work % 4096 === 0) body.time = Date.now();
    }
  }
  return {
    authorization:
      "Swarm " +
      Buffer.from(
        canonical({ ...body, signature: signature(body, auth.identity) }),
      ).toString("base64url"),
  };
}
export function authenticate(
  store: Store,
  authorization: string,
  method: string,
  path: string,
  bytes: Uint8Array,
): { key: string; role: string; grant?: Grant } {
  assert(
    authorization.startsWith("Swarm ") && authorization.length <= 12_000,
    "Signed contributor authorization required",
  );
  const signed = JSON.parse(
    Buffer.from(authorization.slice(6), "base64url").toString(),
  );
  const { signature: sig, ...body } = signed;
  if (store.manifest.version >= 3)
    assert(
      body.swarm === digest(store.manifest),
      "Signed request belongs to another swarm",
    );
  assert(
    body.method === method &&
      body.path === path &&
      body.hash === hash(bytes) &&
      Number.isSafeInteger(body.time) &&
      Math.abs(Date.now() - body.time) <= 30_000 &&
      typeof body.nonce === "string" &&
      body.nonce.length <= 100 &&
      verifies(body, sig, body.author),
    "Invalid signed request",
  );
  const g = store.governance();
  assert(
    !g.conflict || store.manifest.validators.includes(body.author),
    "Only recovery validators may connect during an authority fork",
  );
  const member = g.members!.get(body.author);
  assert(member?.enabled !== false, "Contributor revoked");
  let role: string;
  if (body.author === g.planner) role = "planner";
  else if (store.manifest.validators.includes(body.author)) role = "reviewer";
  else if (
    !store.manifest.restricted &&
    g.manifest.policy?.admission === "public"
  ) {
    assert(
      Number.isSafeInteger(body.work) &&
        body.work >= 0 &&
        hasWork(body, g.manifest.policy.publicWorkBits ?? 12),
      "Public admission proof of work required",
    );
    role = "worker";
  } else {
    const invitation = body.grant as Grant;
    assert(
      invitation &&
        invitation.subject === body.author &&
        invitation.swarm === digest(store.manifest),
      "Invitation does not match contributor or swarm",
    );
    const { signature: grantSig, ...grantBody } = invitation;
    assert(
      invitation.version === 1 &&
        ["worker", "reviewer", "reader"].includes(invitation.role) &&
        invitation.expires > Date.now() &&
        g.authorities.get(invitation.authority) === invitation.issuer &&
        verifies(grantBody, grantSig, invitation.issuer),
      "Invalid or expired invitation",
    );
    // Require the replicated admission event as well as the credential.
    assert(
      member?.enabled && member.role === invitation.role,
      "Contributor admission not replicated",
    );
    role = invitation.role;
  }
  store.db.query("DELETE FROM nonces WHERE expires < ?").run(Date.now());
  try {
    store.db
      .query("INSERT INTO nonces VALUES (?, ?)")
      .run(body.author + ":" + body.nonce, Date.now() + 60_000);
  } catch {
    throw new Error("Replayed signed request");
  }
  return { key: body.author, role, grant: body.grant };
}
