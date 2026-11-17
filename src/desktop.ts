import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { assert } from "./core.ts";
export function installHandler(
  directory: string,
  bunPath: string,
  entry: string,
) {
  assert(
    bunPath.startsWith("/") &&
      entry.startsWith("/") &&
      !/[\r\n]/.test(bunPath + entry),
    "Handler paths must be absolute",
  );
  const quote = (value: string) =>
    '"' + value.replace(/(["`$\\])/g, "\\$1").replace(/%/g, "%%") + '"';
  const destination = resolve(directory);
  mkdirSync(destination, { recursive: true });
  const path = join(destination, "bitswarm.desktop");
  writeFileSync(
    path,
    `[Desktop Entry]\nType=Application\nName=BitSwarm\nExec=${quote(bunPath)} ${quote(entry)} open %u\nTerminal=true\nNoDisplay=true\nMimeType=x-scheme-handler/swarm;\n`,
  );
  return {
    path,
    register: [
      "xdg-mime",
      "default",
      "bitswarm.desktop",
      "x-scheme-handler/swarm",
    ],
  };
}
