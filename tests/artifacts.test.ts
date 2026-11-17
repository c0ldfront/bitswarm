import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkFile } from "../src/artifacts.ts";
import { hash } from "../src/core.ts";
test("file chunks preserve ordering, content identities and full-file integrity", () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-chunks-"));
  try {
    const original = crypto.getRandomValues(new Uint8Array(60_000));
    const data = Buffer.concat(
      Array.from({ length: 10 }, () => Buffer.from(original)),
    );
    const path = join(dir, "application.bin");
    writeFileSync(path, data);
    const file = chunkFile(path);
    expect(file.objects).toHaveLength(4);
    expect(file.root).toBe(hash(file.objects[0].data));
    const index = JSON.parse(Buffer.from(file.objects[0].data).toString());
    expect(index.size).toBe(data.length);
    expect(index.sha256).toBe(hash(data));
    expect(index.chunks).toEqual(
      file.objects.slice(1).map((o) => hash(o.data)),
    );
    expect(
      Buffer.concat(file.objects.slice(1).map((o) => Buffer.from(o.data))),
    ).toEqual(data);
    writeFileSync(path, "");
    const empty = chunkFile(path);
    expect(empty.objects).toHaveLength(1);
    expect(
      JSON.parse(Buffer.from(empty.objects[0].data).toString()).chunks,
    ).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streaming import resumes chunks and restore rejects corrupt content", async () => {
  const { planFile, restoreFile } = await import("../src/artifacts.ts");
  const { readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-stream-"));
  try {
    const path = join(dir, "source");
    const data = Buffer.alloc(900000, 73);
    writeFileSync(path, data);
    const plan = planFile(path);
    const objects = new Map<string, Uint8Array>();
    plan.seed((bytes, id) => objects.set(id, Uint8Array.from(bytes)));
    const destination = join(dir, "restored");
    expect(
      restoreFile((id) => objects.get(id), plan.root, destination).size,
    ).toBe(data.length);
    expect(readFileSync(destination)).toEqual(data);
    const index = JSON.parse(Buffer.from(plan.index).toString());
    objects.set(index.chunks[0], Buffer.from("tampered"));
    expect(() =>
      restoreFile((id) => objects.get(id), plan.root, join(dir, "bad")),
    ).toThrow("corrupt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
