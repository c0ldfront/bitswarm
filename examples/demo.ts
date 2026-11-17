import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  canonical,
  digest,
  identity,
  makeEvent,
  type Manifest,
} from "../src/core.ts";
import { chunkFile } from "../src/artifacts.ts";
import { Store } from "../src/store.ts";
import { serve, sync } from "../src/network.ts";
import { runWorker } from "../src/worker.ts";

// This is a deterministic transport/workflow demo. Reviewers only approve the
// fixture adapter's mechanically checkable observations, not reverse engineering.
const dir = mkdtempSync(join(tmpdir(), "bitswarm-demo-"));
const token = crypto.randomUUID();
const reviewerA = identity(),
  reviewerB = identity();
const manifest: Manifest = JSON.parse(
  readFileSync("examples/reverse-engineering.json", "utf8"),
);
manifest.validators = [reviewerA.publicKey, reviewerB.publicKey];
manifest.quorum = 2;
const source = chunkFile("examples/adapter.ts");
manifest.blocks
  .filter((b) => b.requires.length === 0)
  .forEach((b) => (b.inputs = source.objects.map((o) => o.id)));
const stores = ["reviewer-a", "worker", "reviewer-b"].map(
  (name) => new Store(join(dir, name), manifest),
);
const [a, worker, b] = stores;
// Assign reviewer keys before creating any events; only public keys leave a node.
a.who = reviewerA;
b.who = reviewerB;
source.objects.forEach((o) => a.addBlob(o.data, o.id));
const servers = stores.map((s) => serve(s, token, 0));
async function spread() {
  // Chain topology. C has no direct connection to the original seed A.
  await sync(worker, servers[0].url.toString(), token);
  await sync(b, servers[1].url.toString(), token);
  await sync(worker, servers[2].url.toString(), token);
  await sync(a, servers[1].url.toString(), token);
}
try {
  console.log(
    `Swarm ${digest(manifest)}\nThree live peers; two independent reviewers; six dependent blocks.`,
  );
  await spread();
  for (let round = 0; round < manifest.blocks.length; round++) {
    const result = await runWorker(
      worker,
      ["bun", "examples/adapter.ts"],
      ["static-analysis", "synthesis", "test-design"],
    );
    assert(result?.payload.kind === "result", "Expected a ready block");
    await spread();
    for (const reviewer of [a, b]) {
      const candidate = reviewer
        .state()
        .flatMap((s) => s.candidates)
        .find((c) => c.event.id === result.id);
      assert(candidate?.eligible, "Result evidence unavailable");
      const artifact = JSON.parse(
        Buffer.from(reviewer.blob(result.payload.artifact)!).toString(),
      );
      assert(
        artifact.kind === "fixture-observation" &&
          artifact.block === result.payload.block,
        "Unexpected fixture output",
      );
      for (const observation of artifact.sources)
        assert(
          reviewer.blob(observation.hash)?.length === observation.bytes,
          "Incorrect byte observation",
        );
      reviewer.addEvent(
        makeEvent(manifest, reviewer.who, {
          kind: "review",
          result: result.id,
          verdict: "approve",
          reason:
            "Fixture source hashes and byte counts independently reproduced. No semantic findings claimed.",
        }),
      );
    }
    await spread();
    await spread();
    console.log(
      `Accepted ${result.payload.block}: ${result.id.slice(0, 12)} (2/2 reviews)`,
    );
  }
  const states = stores.map((s) => s.state());
  assert(
    states.every((ss) => ss.every((s) => s.status === "accepted")),
    "Not all work accepted",
  );
  assert(
    stores.every((s) => canonical(s.inventory()) === canonical(a.inventory())),
    "Peers failed to converge",
  );
  console.log(
    `Converged: ${a.inventory().events.length} signed events, ${a.inventory().blobs.length} objects. All blocks accepted.`,
  );
} finally {
  servers.forEach((s) => s.stop(true));
  stores.forEach((s) => s.close());
  rmSync(dir, { recursive: true, force: true });
}
