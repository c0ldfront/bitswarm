import { test, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkFile, restoreFile } from "../src/artifacts.ts";
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
  const { planFile } = await import("../src/artifacts.ts");
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
    expect(readdirSync(dir).sort()).toEqual(["restored", "source"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore publishes verified bytes atomically and preserves a competing writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-publish-"));
  try {
    const source = join(dir, "source");
    const destination = join(dir, "output");
    const contents = Buffer.concat([
      Buffer.alloc(256 * 1024, 41),
      Buffer.from("last"),
    ]);
    writeFileSync(source, contents);
    const { root, objects } = chunkFile(source);
    const bytes = new Map(objects.map(({ id, data }) => [id, data]));
    const last = objects[2].id;
    const read = (id: string) => {
      if (id === last) expect(existsSync(destination)).toBe(false);
      return bytes.get(id);
    };
    restoreFile(read, root, destination);
    expect(readFileSync(destination)).toEqual(contents);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    rmSync(destination);
    expect(() =>
      restoreFile(
        (id) => {
          const chunk = read(id);
          if (id === last)
            writeFileSync(destination, "other writer", { flag: "wx" });
          return chunk;
        },
        root,
        destination,
      ),
    ).toThrow(/EEXIST/);
    expect(readFileSync(destination, "utf8")).toBe("other writer");
    expect(() =>
      restoreFile(
        (id) => {
          expect(id).toBe(root);
          return bytes.get(id);
        },
        root,
        destination,
      ),
    ).toThrow(/EEXIST/);
    expect(readdirSync(dir).sort()).toEqual(["output", "source"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("streaming import hands off stable chunk bytes and detects source changes before publishing an index", async () => {
  const { planFile } = await import("../src/artifacts.ts");
  const path = mkdtempSync(join(tmpdir(), "bitswarm-import-")),
    source = join(path, "two");
  try {
    const bytes = Buffer.concat([
      Buffer.alloc(256 * 1024, 1),
      Buffer.alloc(256 * 1024, 2),
    ]);
    writeFileSync(source, bytes);
    const plan = planFile(source),
      objects = new Map<string, Uint8Array>();
    plan.seed((data, id) => objects.set(id, data));
    for (const [id, data] of objects) expect(hash(data)).toBe(id);
    objects.clear();
    bytes[bytes.length - 1] = 3;
    writeFileSync(source, bytes);
    expect(() => plan.seed((data, id) => objects.set(id, data))).toThrow(
      "changed",
    );
    expect(objects.has(plan.root)).toBe(false);
  } finally {
    rmSync(path, { force: true, recursive: true });
  }
});
