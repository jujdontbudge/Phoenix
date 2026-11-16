import { parseArgs } from "node:util";
import { createScenarioMoment, createSnapshotMoment } from "@phoenix/setup";
import { acceptMoment } from "@phoenix/approvals";
import { readMomentBundle } from "@phoenix/store";
import { approver, confirm, phoenixHome } from "./approval-prompt.ts";
import { runMomentAutoCommand } from "./moment-auto.ts";
import { runMomentPackCommand } from "./moment-pack.ts";
import { runMomentSessionCommand } from "./moment-session.ts";

const USAGE = [
  "Usage: phoenix moment create --capture <dir> [--task <key>] --mark <event> [--start beginning] --id <id>",
  "         [--connector <name>:<mcp|cli|http> ...] [--check <file> | --correction <event>]",
  "         [--workdir <snapshot> | --no-workdir] [--include-ignored | --no-include-ignored] [--prompt <text>] [--timezone <tz>] <out-dir>",
  "       phoenix moment create --scenario <dir> [--home <dir>] [--who <name>] <out-dir>",
  "       phoenix moment create --auto ... (run with --auto for its options)",
  "       phoenix moment create --session <session-file> --recipe <recipe.yaml> (--at <line> | --from-beginning) --id <id> --check <check.yaml> <out-dir>",
  "       phoenix moment create --mark <mark-dir> --id <id> --check <check.yaml> <out-dir>",
  "       phoenix moment create --made-up <folder> --recipe <recipe.yaml> --id <id> <out-dir>",
  "       phoenix moment accept [--home <dir>] [--who <name>] <moment-dir>",
  "       phoenix moment pack --out <packed-dir> [--archive <file.tar>] [--presidio <analyzer-url>] [--home <dir>] [--who <name>] <moment-dir>",
].join("\n");

const SURFACES = ["mcp", "cli", "http"] as const;

export async function runMomentCommand(args: string[]): Promise<number> {
  if (args[0] === "create" && args.includes("--auto")) return runMomentAutoCommand(args.slice(1));
  if (args[0] === "create" && !args.includes("--capture") && ["--session", "--mark", "--made-up"].some(flag => args.includes(flag))) return runMomentSessionCommand(args.slice(1));
  if (args[0] === "pack") return runMomentPackCommand(args.slice(1));
  const { values: v, positionals } = parseArgs({
    args, allowPositionals: true, options: {
      capture: { type: "string" }, task: { type: "string" }, mark: { type: "string" }, start: { type: "string" }, id: { type: "string" },
      connector: { type: "string", multiple: true }, check: { type: "string" }, correction: { type: "string" },
      workdir: { type: "string" }, "no-workdir": { type: "boolean" }, "include-ignored": { type: "boolean" }, "no-include-ignored": { type: "boolean" },
      prompt: { type: "string" }, timezone: { type: "string" }, scenario: { type: "string" }, home: { type: "string" }, who: { type: "string" },
    },
  });
  const [command, root, ...rest] = positionals;
  if (!root || rest.length) throw new Error(USAGE);
  if (command === "accept") {
    const bundle = await readMomentBundle(root);
    process.stdout.write(`Moment ${bundle.manifest.id}, locked ${bundle.lock.how} by ${bundle.lock.approved_by ?? "auto"} at ${bundle.lock.approved_at}\n\nCheck:\n${Buffer.from(bundle.files.get("check.yaml")!).toString().trimEnd()}\n\n`);
    if (!await confirm("Accept this moment's check?")) { process.stderr.write("Not accepted; nothing was recorded\n"); return 1; }
    const { entry } = await acceptMoment(root, { home: phoenixHome(v.home), who: approver(v.who), reviewed: bundle.lockHash });
    process.stdout.write(JSON.stringify({ ledger: entry }) + "\n");
    return 0;
  }
  if (command !== "create") throw new Error(USAGE);
  if (v.scenario !== undefined) {
    const { manifest, locked } = await createScenarioMoment({ from: v.scenario, out: root, home: phoenixHome(v.home), who: approver(v.who) });
    process.stdout.write(JSON.stringify({ moment: manifest.id, bundle: root, locked }) + "\n");
    return 0;
  }
  if (!v.capture || !v.mark || !v.id || (v.check && v.correction) || (v.workdir && v["no-workdir"]) || (v["include-ignored"] && v["no-include-ignored"])) throw new Error(USAGE);
  const connectors = (v.connector ?? []).map((spec) => {
    const [name, surface] = spec.split(":");
    if (!name || !SURFACES.includes(surface as never)) throw new Error(`Connector must be <name>:<mcp|cli|http>: ${spec}`);
    return { name, surface: surface as (typeof SURFACES)[number] };
  });
  if (v.start !== undefined && v.start !== "beginning") throw new Error("A moment made from a capture replays from the beginning only: Phoenix does not replay recorded LLM traffic to reach a later point");
  const start = "beginning" as const;
  const manifest = await createSnapshotMoment({
    capture: v.capture, task: v.task, mark: v.mark, start, id: v.id, out: root, connectors, check: v.check, correction: v.correction,
    workdir: v["no-workdir"] ? false : v.workdir,
    includeIgnored: v["include-ignored"] ? true : v["no-include-ignored"] ? false : undefined,
    prompt: v.prompt, timezone: v.timezone,
  });
  process.stdout.write(JSON.stringify({ moment: manifest.id, bundle: root, next: `Edit ${root}/check.draft.yaml, then run phoenix check approve ${root}` }) + "\n");
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await runMomentCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write((error as Error).message + "\n"); process.exitCode = 1; }
}
