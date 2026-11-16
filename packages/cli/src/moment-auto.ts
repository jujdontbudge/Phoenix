import { parseArgs } from "node:util";
import { setupSnapshotMoment } from "@phoenix/setup";
import { MODEL_OPTIONS, setupProvider } from "./setup-model.ts";

const USAGE = [
  "Usage: phoenix moment create --auto --capture <dir> [--task <key>] --mark <event> [--start beginning] --id <id>",
  "         [--check <file> | --correction <event>] [--workdir <snapshot> | --no-workdir] [--include-ignored | --no-include-ignored]",
  "         [--plugins <dir> ...] [--doc <file> ...] [--model <id> --model-endpoint <url> [--model-dialect <dialect>]]",
  "         [--prompt <text>] [--timezone <tz>] <out-dir>",
  "  Model request headers (credentials) come only from the PHOENIX_SETUP_MODEL_HEADERS environment variable, as a JSON object.",
].join("\n");

export async function runMomentAutoCommand(args: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args, allowPositionals: true, options: {
      auto: { type: "boolean" }, capture: { type: "string" }, task: { type: "string" }, mark: { type: "string" }, start: { type: "string" }, id: { type: "string" },
      check: { type: "string" }, correction: { type: "string" }, workdir: { type: "string" }, "no-workdir": { type: "boolean" },
      "include-ignored": { type: "boolean" }, "no-include-ignored": { type: "boolean" }, prompt: { type: "string" }, timezone: { type: "string" },
      plugins: { type: "string", multiple: true }, doc: { type: "string", multiple: true }, ...MODEL_OPTIONS,
    },
  });
  const [out, ...rest] = positionals;
  if (!out || rest.length || !v.capture || !v.mark || !v.id || (v.check && v.correction) || (v.workdir && v["no-workdir"]) || (v["include-ignored"] && v["no-include-ignored"])) throw new Error(USAGE);
  const provider = setupProvider(v);
  if (v.start !== undefined && v.start !== "beginning") throw new Error("A moment made from a capture replays from the beginning only: Phoenix does not replay recorded LLM traffic to reach a later point");
  const start = "beginning" as const;
  const { manifest, fills, missing } = await setupSnapshotMoment({
    capture: v.capture, task: v.task, mark: v.mark, start, id: v.id, out, check: v.check, correction: v.correction,
    workdir: v["no-workdir"] ? false : v.workdir, includeIgnored: v["include-ignored"] ? true : v["no-include-ignored"] ? false : undefined,
    prompt: v.prompt, timezone: v.timezone, plugins: v.plugins, docs: v.doc, ...(provider ? { provider } : {}),
  });
  const connectors = Object.fromEntries(Object.entries(manifest.connectors ?? {}).map(([name, c]) => [name, { surface: c.surface, routes: c.routes, tier: c.tier, read_only: c.read_only ?? [] }]));
  process.stdout.write(JSON.stringify({
    moment: manifest.id, bundle: out, model: manifest.model ?? null, connectors,
    fills: fills.map(({ path, fill }) => ({ path, item: fill.item, connector: fill.connector, tag: fill.tag, producer: fill.producer, evidence: fill.basis.evidence })),
    missing, next: `phoenix check draft ${out}, then phoenix check approve ${out}`,
  }, null, 2) + "\n");
  return 0;
}
