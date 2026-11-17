import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { assert } from "../src/core.ts";
const archive = JSON.parse(
  readFileSync(
    process.argv[2] || "artifacts/benchmark/swarm-proof.json",
    "utf8",
  ),
);
const directory = mkdtempSync(join(tmpdir(), "bitswarm-replay-"));
const store = new Store(directory, archive.manifest);
try {
  for (const [id, data] of Object.entries(archive.objects))
    store.addBlob(Buffer.from(data as string, "base64"), id);
  for (const event of archive.events.slice().reverse()) store.addEvent(event);
  const state = store.state();
  assert(
    state.every((s) => s.status === "accepted"),
    "Archive contains incomplete or unaccepted work",
  );
  const checks = store
    .events()
    .filter((e) => e.payload.kind === "verification")
    .flatMap((e) =>
      e.payload.kind === "verification"
        ? JSON.parse(Buffer.from(store.blob(e.payload.report)!).toString())
            .checks.checks
        : [],
    );
  assert(
    checks.every((c) => c.passed),
    "Archive contains failed verification checks",
  );
  console.log(
    JSON.stringify(
      {
        swarm: store.inventory().swarm,
        signaturesVerified: store.events().length,
        acceptedBlocks: state.length,
        passedChecks: checks.length,
        objects: store.inventory().blobs.length,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
