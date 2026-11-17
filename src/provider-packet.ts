import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { assert, hash, isHash, MAX_BLOB } from "./core.ts";
import type { packet } from "./worker.ts";

type WorkerPacket = ReturnType<typeof packet> & {
  workspace: string;
  files?: { hash: string; path: string }[];
};
type Source = WorkerPacket["sources"][number];
const CHUNK_BYTES = 256 * 1024;
const EVIDENCE_BYTES = 64 * 1024;

function decode(source: Source) {
  assert(
    isHash(source.id) &&
      source.encoding === "base64" &&
      typeof source.data === "string" &&
      source.data.length <= 4 * Math.ceil(MAX_BLOB / 3),
    "Invalid source envelope",
  );
  const bytes = Buffer.from(source.data, "base64");
  assert(
    bytes.length <= MAX_BLOB && hash(bytes) === source.id,
    "Source hash mismatch",
  );
  return bytes;
}

function filePrefix(
  workspace: string,
  source: Source,
  raw: Buffer,
  path: string,
  remaining: number,
) {
  const index = JSON.parse(raw.toString());
  assert(
    index?.type === "bitswarm.file.v1" &&
      typeof index.name === "string" &&
      index.name &&
      basename(index.name) === index.name &&
      ![".", ".."].includes(index.name) &&
      isHash(index.sha256) &&
      Number.isSafeInteger(index.size) &&
      index.size >= 0 &&
      index.size <= 2 * 1024 ** 3 &&
      Array.isArray(index.chunks) &&
      index.chunks.every(isHash),
    "Invalid file evidence index",
  );
  const relative = join("sources", source.id, index.name);
  const expected = join(realpathSync(workspace), relative);
  assert(
    resolve(path) === resolve(workspace, relative) &&
      realpathSync(path) === expected,
    "File evidence outside assigned workspace path",
  );
  const fd = openSync(
    expected,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    assert(
      stat.isFile() && stat.size === index.size,
      "File evidence size mismatch",
    );
    const bytes = Buffer.alloc(
      remaining > 0 ? Math.min(index.size, CHUNK_BYTES) : 0,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert(n > 0, "File evidence ended early");
      offset += n;
    }
    if (remaining > 0) {
      const expectedHash =
        index.size <= CHUNK_BYTES ? index.sha256 : index.chunks[0];
      assert(hash(bytes) === expectedHash, "File evidence hash mismatch");
    }
    return {
      name: index.name as string,
      sha256: index.sha256 as string,
      size: stat.size,
      bytes,
    };
  } finally {
    closeSync(fd);
  }
}

// Provider processes with tools disabled receive only evidence selected by the local worker.
export function buildProviderPacket(input: WorkerPacket) {
  let remaining = EVIDENCE_BYTES;
  function excerpt(bytes: Buffer, size = bytes.length) {
    const slice = bytes.subarray(0, Math.min(16 * 1024, remaining));
    remaining -= slice.length;
    let encoding = "utf8",
      data: string;
    try {
      data = new TextDecoder("utf-8", { fatal: true }).decode(slice);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(data)) throw Error();
    } catch {
      encoding = "base64";
      data = slice.toString("base64");
    }
    return {
      encoding,
      data,
      size,
      includedBytes: slice.length,
      truncated: slice.length < size,
    };
  }
  const pointers = new Map(
    (input.files ?? []).map((file) => [file.hash, file.path]),
  );
  const sources = new Map(
    [...(input.inputs ?? []), ...(input.sources ?? [])].map((source) => [
      source.id,
      source,
    ]),
  );
  const declared = new Set([
    ...(input.block.inputs ?? []),
    ...(input.block.optionalInputs ?? []),
  ]);
  for (const id of sources.keys())
    assert(declared.has(id), "Source outside assigned block");
  for (const id of pointers.keys())
    assert(sources.has(id), "File outside assigned sources");
  const evidence = [...sources.values()].map((source) => {
    const bytes = decode(source);
    const path = pointers.get(source.id);
    if (path === undefined) return { id: source.id, ...excerpt(bytes) };
    const file = filePrefix(input.workspace, source, bytes, path, remaining);
    return {
      id: source.id,
      name: file.name,
      sha256: file.sha256,
      ...excerpt(file.bytes, file.size),
    };
  });
  return {
    protocol: input.protocol,
    swarm: input.swarm,
    project: input.project,
    block: input.block,
    sources: evidence,
    dependencies: (input.dependencies ?? []).map(
      ({ block, result, summary, artifact }) => ({
        block,
        result,
        summary,
        artifact: { id: artifact.id, ...excerpt(decode(artifact)) },
      }),
    ),
    previous: (input.previous ?? []).map(({ result, summary, reports }) => ({
      result,
      summary,
      reports: reports.map((report) =>
        excerpt(Buffer.from(JSON.stringify(report))),
      ),
    })),
  };
}
