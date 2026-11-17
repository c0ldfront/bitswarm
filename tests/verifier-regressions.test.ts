import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, hash, makeEvent, type Manifest } from "../src/core.ts";
import { Store } from "../src/store.ts";
import { claim, submit } from "../src/worker.ts";
import { verifyResult } from "../src/verification.ts";

function fixture(verifierHash?: string, eventQuota = 2000) {
  const directory = mkdtempSync(join(tmpdir(), "bitswarm-verify-"));
  const reviewer = identity();
  const manifest: Manifest = {
    version: 4,
    name: "Verification",
    description: "Verification evidence",
    validators: [reviewer.publicKey],
    quorum: 1,
    policy: { eventQuota },
    blocks: [
      {
        id: "unit",
        title: "Unit",
        instructions: "Calculate",
        requires: [],
        inputs: [],
        capabilities: [],
        contract: {
          timeoutMs: 10000,
          maxAttempts: 2,
          maxTokens: 0,
          maxCostMicros: 0,
          verifier: "checks",
          ...(verifierHash ? { verifierHash } : {}),
        },
      },
    ],
  };
  const store = new Store(directory, manifest);
  const result = submit(
    store,
    claim(store, "unit").id,
    Buffer.from("{}"),
    "Implementation",
  );
  store.who = reviewer;
  return {
    store,
    directory,
    manifest,
    result,
    reviewer,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("only a consistent negative report for the candidate and pinned recipe can reject work", () => {
  const recipe = hash("pinned checks");
  const { store, manifest, result, reviewer, cleanup } = fixture(recipe);
  try {
    const add = (body: object) => {
      store.addEvent(
        makeEvent(manifest, reviewer, {
          kind: "verification",
          verifier: "checks",
          result: result.id,
          passed: false,
          report: store.addBlob(Buffer.from(JSON.stringify(body))),
        }),
      );
    };
    const passing = { passed: true, checks: [{ passed: true }] },
      failing = { passed: false, checks: [{ passed: false }] };
    const report = {
      recipe,
      verifier: "checks",
      result: result.id,
      checks: failing,
    };
    for (const patch of [
      { recipe: hash("old recipe") },
      { result: hash("other result") },
      { verifier: "other" },
      { checks: passing },
      { checks: { ...failing, checks: [] } },
      { checks: { ...failing, checks: [{ passed: true }] } },
    ]) {
      add({ ...report, ...patch });
      expect(store.state()[0].candidates[0].verification).toBe("pending");
    }
    add(report);
    expect(store.state()[0].candidates[0].verification).toBe("failed");
  } finally {
    cleanup();
  }
});
test("an inconsistent local verifier conclusion never produces a signed attestation or stored report", async () => {
  const { store, directory, result, cleanup } = fixture();
  try {
    const script = join(directory, "check.ts");
    writeFileSync(
      script,
      'console.log(JSON.stringify({passed:true,checks:[{name:"parity",passed:false}]}));',
    );
    const before = store.inventory();
    await expect(
      verifyResult(store, result.id, ["bun", script], "process"),
    ).rejects.toThrow("verdict");
    expect(store.inventory()).toEqual(before);
  } finally {
    cleanup();
  }
});
test("failed attestation publication rolls back the verifier report", async () => {
  const { store, directory, manifest, result, reviewer, cleanup } = fixture(
    undefined,
    2,
  );
  try {
    for (let n = 0; n < 2; n++)
      store.addEvent(
        makeEvent(manifest, reviewer, {
          kind: "review",
          result: result.id,
          verdict: "approve",
          reason: "evidence",
        }),
      );
    const before = store.inventory();
    const script = join(directory, "check.ts");
    writeFileSync(
      script,
      "console.log(JSON.stringify({passed:true,checks:[{passed:true}]}))",
    );
    await expect(
      verifyResult(store, result.id, ["bun", script], "process"),
    ).rejects.toThrow("quota");
    expect(store.inventory()).toEqual(before);
  } finally {
    cleanup();
  }
});
test("a changed verifier cannot run under its previous pin during task hydration", async () => {
  const files = mkdtempSync(join(tmpdir(), "bitswarm-verifier-change-"));
  const command = ["bun", join(files, "check.ts")];
  const helper = join(files, "helper.ts");
  writeFileSync(helper, "export const outcome=true;");
  writeFileSync(
    command[1],
    'import {outcome} from "./helper.ts";console.log(JSON.stringify({passed:outcome,checks:[{passed:outcome}]}));',
  );
  const { recipeHash } = await import("../src/recipe.ts");
  const { handle } = await import("../src/network.ts");
  const { store, manifest, result, cleanup } = fixture(
    await recipeHash(command),
  );
  const source = new Store(join(files, "peer"), manifest);
  const token = "verifier-hydration-credential-fixture-only";
  const priorToken = process.env.BITSWARM_TOKEN;
  process.env.BITSWARM_TOKEN = token;
  let edited = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (!edited) {
        writeFileSync(helper, "export const outcome=false;");
        edited = true;
      }
      return handle(source, token, req);
    },
  });
  try {
    for (const event of store.events()) source.addEvent(event);
    if (result.payload.kind !== "result") throw Error("Missing result");
    const artifact = result.payload.artifact;
    source.addBlob(store.blob(artifact)!, artifact);
    store.db.query("DELETE FROM blobs WHERE id=?").run(artifact);
    store.configure({ download: "tasks", upload: "results" });
    store.rememberPeer(server.url.origin);
    await expect(
      verifyResult(store, result.id, command, "process"),
    ).rejects.toThrow("pinned contract");
    expect(edited).toBe(true);
    expect(store.events().some((e) => e.payload.kind === "verification")).toBe(
      false,
    );
  } finally {
    if (priorToken === undefined) delete process.env.BITSWARM_TOKEN;
    else process.env.BITSWARM_TOKEN = priorToken;
    server.stop(true);
    source.close();
    cleanup();
    rmSync(files, { recursive: true, force: true });
  }
});
