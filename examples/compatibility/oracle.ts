import { color, decode, header, run, type Format } from "./codec.ts";
export const parts = ["header", "palette", "runs"] as const;
export type Part = (typeof parts)[number];
export function parameters(trial: number): Format {
  return trial % 2
    ? {
        header: { endian: "BE", heightFirst: true },
        palette: { order: "GBR", xor: 37 },
        runs: { indexFirst: true, bias: 1 },
      }
    : {
        header: { endian: "LE", heightFirst: false },
        palette: { order: "BRG", xor: 19 },
        runs: { indexFirst: false, bias: 2 },
      };
}
function encodeHeader(w: number, h: number, f: Format) {
  return (f.header.heightFirst ? [h, w] : [w, h]).flatMap((n) =>
    f.header.endian === "LE" ? [n & 255, n >> 8] : [n >> 8, n & 255],
  );
}
function encodeColor(rgb: number[], f: Format) {
  return [...f.palette.order].map((k) => rgb["RGB".indexOf(k)] ^ f.palette.xor);
}
function encodeRun(i: number, n: number, f: Format) {
  return f.runs.indexFirst ? [i, n - f.runs.bias] : [n - f.runs.bias, i];
}
export function samples(part: Part, f: Format, offset: number, count: number) {
  return Array.from({ length: count }, (_, j) => {
    const n = j + offset;
    if (part === "header") {
      const width = 3 + n * 7,
        height = 310 + n * 13;
      return { bytes: encodeHeader(width, height, f), output: [width, height] };
    }
    if (part === "palette") {
      const rgb = [
        (3 + n * 7) % 256,
        (74 + n * 13) % 256,
        (177 + n * 17) % 256,
      ];
      return { bytes: encodeColor(rgb, f), output: rgb };
    }
    const index = n % 4,
      length = 4 + (n % 19);
    return {
      bytes: encodeRun(index, length, f),
      output: { index, count: length },
    };
  });
}
export function checks(part: Part | "image", candidate: Format, f: Format) {
  const matches = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  return Array.from({ length: 32 }, (_, i) => {
    try {
      if (part === "image") {
        const w = 4 + i,
          h = 3 + (i % 5),
          table = Array.from({ length: 4 }, (_, k) => [
            i + 9 * k,
            200 - i - k,
            3 + i + 13 * k,
          ]);
        const bytes = [
          ...encodeHeader(w, h, f),
          ...table.flatMap((rgb) => encodeColor(rgb, f)),
        ];
        const pixels: number[][] = [];
        for (let y = 0; y < h; y++) {
          const k = (y + 2 * i) % 4;
          bytes.push(...encodeRun(k, w, f));
          for (let x = 0; x < w; x++) pixels.push(table[k]);
        }
        return matches(decode(bytes, candidate), {
          width: w,
          height: h,
          pixels,
        });
      }
      const { bytes, output } = samples(part, f, 100 + i, 1)[0];
      return matches(
        part === "header"
          ? header(bytes, candidate.header)
          : part === "palette"
            ? color(bytes, candidate.palette)
            : run(bytes, candidate.runs),
        output,
      );
    } catch {
      return false;
    }
  });
}
