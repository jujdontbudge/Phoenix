#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, captureRuntime } from "@phoenix/capture";
import { flagCommand, taskCommand, correctionCommand, flagServer } from "./capture-notes.ts";

export async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === "flag") return flagCommand(rest);
  if (command === "task") return taskCommand(rest);
  if (command === "correct") return correctionCommand(rest);
  if (command === "flag-server") return flagServer();
  if (command !== "capture") {
    if (command && await captureRuntime(command, rest)) return;
    throw new Error("Usage: phoenix capture --recipe recipe.yaml [--routes mcp-proxy,cli-proxy] -- command ...");
  }
  const split = rest.indexOf("--");
  if (split < 0 || !rest[split + 1]) throw new Error("Name a harness command after --");
  const { values } = parseArgs({ args: rest.slice(0, split), options: {
    recipe: { type: "string" }, routes: { type: "string" }, cwd: { type: "string" }, output: { type: "string" }, contract: { type: "string" }, "copy-ignored": { type: "boolean" },
  } });
  if (!values.recipe) throw new Error("Name a --recipe file");
  const result = await launch({ recipe: values.recipe, cwd: values.cwd, root: values.output, contract: values.contract, routes: values.routes?.split(",").filter(Boolean), copyIgnored: values["copy-ignored"], command: rest.slice(split + 1), entry: fileURLToPath(import.meta.url) });
  if (result.signal) process.kill(process.pid, result.signal); else process.exitCode = result.code ?? 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv.slice(2)); } catch { process.stderr.write("Phoenix capture failed; no raw payload is logged\n"); process.exitCode = 1; }
}
