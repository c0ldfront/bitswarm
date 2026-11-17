import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex } from "../src/codex.ts";

test("native Codex adapter sends task-specific packets and enforces reported usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bitswarm-codex-"));
  const binary = join(dir, "fake-codex");
  const previous = process.env.BITSWARM_CODEX_MODEL;
  try {
    writeFileSync(
      binary,
      `#!${process.execPath}
const args=process.argv.slice(2);
const packet=JSON.parse(await Bun.stdin.text());
await Bun.write(args[args.indexOf('--output-last-message')+1],JSON.stringify({summary:'fixture',artifact_json:JSON.stringify({args,packet})}));
console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'private'}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'inspect target',exit_code:0,aggregated_output:'evidence'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}));
`,
      { mode: 0o700 },
    );
    process.env.BITSWARM_CODEX_MODEL = "operator-selected-model";
    const input = {
      workspace: dir,
      deadline: Date.now() + 10000,
      block: {
        instructions: "Investigate the supplied image decoder",
        contract: { maxTokens: 20 },
      },
      sources: [{ id: "source", data: "bytes", path: "source.bin" }],
    };
    const result = await runCodex(input, { binary });
    expect(result.usage).toEqual({ tokens: 15, costMicros: 0 });
    const args = result.artifact.args;
    expect(args[args.indexOf("--model") + 1]).toBe("operator-selected-model");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ephemeral");
    expect(result.artifact.packet.instruction).not.toContain("basename");
    expect(result.artifact.packet.packet.block.instructions).toBe(
      input.block.instructions,
    );
    expect(result.artifact.packet.packet.sources[0].data).toBeUndefined();
    expect(result.transcript).toEqual([
      { command: "inspect target", exitCode: 0, output: "evidence" },
    ]);
    input.block.contract.maxTokens = 10;
    await expect(runCodex(input, { binary })).rejects.toThrow("token budget");
  } finally {
    if (previous === undefined) delete process.env.BITSWARM_CODEX_MODEL;
    else process.env.BITSWARM_CODEX_MODEL = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
