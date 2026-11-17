import { createHash, randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  readSync,
  writeSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assert, canonical, hash } from "./core.ts";
export function chunkFile(path: string) {
  const data = readFileSync(path);
  assert(
    data.length <= 24 * 1024 * 1024,
    "Prototype input limit is 24 MiB per file",
  );
  const chunks: { id: string; data: Uint8Array }[] = [];
  for (let offset = 0; offset < data.length; offset += 256 * 1024) {
    const piece = data.subarray(offset, offset + 256 * 1024);
    chunks.push({ id: hash(piece), data: piece });
  }
  const index = Buffer.from(
    canonical({
      type: "bitswarm.file.v1",
      name: basename(path),
      size: data.length,
      sha256: hash(data),
      chunks: chunks.map((c) => c.id),
    }),
  );
  return {
    root: hash(index),
    objects: [{ id: hash(index), data: index }, ...chunks],
  };
}

// Streaming, two-pass imports keep memory bounded regardless of application size.
export function planFile(path: string) {
  const fd = openSync(path, "r");
  const chunks: string[] = [];
  const whole = createHash("sha256");
  let size = 0;
  try {
    const stat = fstatSync(fd);
    assert(
      stat.isFile() && stat.size <= 2 * 1024 * 1024 * 1024,
      "Input must be a regular file of at most 2 GiB",
    );
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const piece = buffer.subarray(0, bytes);
      size += bytes;
      chunks.push(hash(piece));
      whole.update(piece);
    }
    assert(size === stat.size, "Input changed during hashing");
  } finally {
    closeSync(fd);
  }
  const index = Buffer.from(
    canonical({
      type: "bitswarm.file.v1",
      name: basename(path),
      size,
      sha256: whole.digest("hex"),
      chunks,
    }),
  );
  const root = hash(index);
  return {
    root,
    index,
    size,
    objects: chunks.length + 1,
    seed: (put: (data: Uint8Array, id: string) => unknown) => {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(256 * 1024);
        let n = 0;
        for (;;) {
          const bytes = readSync(fd, buffer, 0, buffer.length, null);
          if (!bytes) break;
          assert(n < chunks.length, "Input changed during import");
          const piece = Buffer.from(buffer.subarray(0, bytes));
          const id = chunks[n++];
          assert(hash(piece) === id, "Input changed during import");
          put(piece, id);
        }
        assert(n === chunks.length, "Input changed during import");
        put(index, root);
      } finally {
        closeSync(fd);
      }
    },
  };
}

export function restoreFile(
  read: (id: string) => Uint8Array | undefined,
  root: string,
  destination: string,
) {
  const raw = read(root);
  assert(raw && hash(raw) === root, "Missing or corrupt file index");
  const index = JSON.parse(Buffer.from(raw).toString());
  assert(
    index.type === "bitswarm.file.v1" &&
      Array.isArray(index.chunks) &&
      index.chunks.length <= 8192 &&
      index.chunks.every(
        (id: unknown) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id),
      ) &&
      Number.isSafeInteger(index.size) &&
      index.size >= 0 &&
      index.size <= 2 * 1024 * 1024 * 1024 &&
      typeof index.sha256 === "string",
    "Invalid file index",
  );
  if (lstatSync(destination, { throwIfNoEntry: false }))
    throw Object.assign(
      new Error(`EEXIST: destination already exists: ${destination}`),
      {
        code: "EEXIST",
        path: destination,
      },
    );
  const temporary = join(
    dirname(resolve(destination)),
    `.bitswarm-restore-${randomUUID()}`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  let size = 0;
  const whole = createHash("sha256");
  try {
    try {
      for (const id of index.chunks) {
        const chunk = read(id);
        assert(chunk && hash(chunk) === id, "Missing or corrupt source chunk");
        size += chunk.length;
        assert(size <= index.size, "File size exceeds index");
        whole.update(chunk);
        let offset = 0;
        while (offset < chunk.length)
          offset += writeSync(fd, chunk, offset, chunk.length - offset);
      }
      assert(
        size === index.size && whole.digest("hex") === index.sha256,
        "Full-file integrity verification failed",
      );
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, destination);
    return { path: destination, size, sha256: index.sha256 };
  } finally {
    unlinkSync(temporary);
  }
}
