// Candidate descriptions configure the decoder. The oracle and its samples stay with the evaluator.
export type Format = {
  header: { endian: "LE" | "BE"; heightFirst: boolean };
  palette: { order: string; xor: number };
  runs: { indexFirst: boolean; bias: number };
};
export function header(bytes: number[], p: Format["header"]) {
  const word = (i: number) =>
    p.endian === "LE"
      ? bytes[i] + 256 * bytes[i + 1]
      : 256 * bytes[i] + bytes[i + 1];
  return p.heightFirst ? [word(2), word(0)] : [word(0), word(2)];
}
export function color(bytes: number[], p: Format["palette"]) {
  return [..."RGB"].map((k) => bytes[p.order.indexOf(k)] ^ p.xor);
}
export function run(pair: number[], p: Format["runs"]) {
  return {
    index: pair[p.indexFirst ? 0 : 1],
    count: pair[p.indexFirst ? 1 : 0] + p.bias,
  };
}
export function decode(bytes: number[], p: Format) {
  const [width, height] = header(bytes, p.header);
  if (width < 1 || height < 1 || width * height > 2048)
    throw Error("Invalid dimensions");
  const table = Array.from({ length: 4 }, (_, i) =>
    color(bytes.slice(4 + 3 * i, 7 + 3 * i), p.palette),
  );
  const pixels: number[][] = [];
  for (let i = 16; i < bytes.length; i += 2) {
    const { index, count } = run(bytes.slice(i, i + 2), p.runs);
    if (!table[index] || count < 1 || pixels.length + count > width * height)
      throw Error("Invalid run");
    for (let n = 0; n < count; n++) pixels.push(table[index]);
  }
  if (pixels.length !== width * height) throw Error("Truncated image");
  return { width, height, pixels };
}
