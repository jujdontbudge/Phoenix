import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Workbench } from "./api.ts";
import { createWorkspace } from "./workspace.ts";

type Schema = { type: "object"; properties: Record<string, object>; required?: string[]; additionalProperties: false };
interface Operation { description: string; input: Schema; run(api: Workbench, args: never): Promise<unknown> }

const object = (properties: Record<string, object>, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const id = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" };
const start = { description: "beginning or mark; defaults to each moment's own start. A session moment's start is fixed when the moment is made", enum: ["beginning", "mark"] };

export const OPERATIONS: Record<string, Operation> = {
  listMoments: { description: "List the locked moments in this workspace's set, with each check (read-only), its hash and ledger entry.", input: object({}), run: api => api.listMoments() },
  readTrace: {
    description: "Read events from a moment's recorded run ({moment}) or a replay sample ({replay, sample, attempt?}). Returns 50 events by default; bodies are text, truncated past 2000 characters.",
    input: object({ ref: { oneOf: [object({ moment: { type: "string" } }, ["moment"]), object({ replay: id, sample: { type: "integer", minimum: 0 }, attempt: { type: "integer", minimum: 0 } }, ["replay", "sample"])] }, from: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["ref"]),
    run: (api, a: { ref: Parameters<Workbench["readTrace"]>[0]; from?: number; limit?: number }) => api.readTrace(a.ref, { from: a.from, limit: a.limit }),
  },
  listEditable: { description: "List the harness contract's editable globs and the files that match them.", input: object({}), run: api => api.listEditable() },
  readFile: { description: "Read a file in the workspace's harness tree.", input: object({ path: { type: "string" } }, ["path"]), run: (api, a: { path: string }) => api.readFile(a.path) },
  editFile: { description: "Replace a whole file in the harness tree with content, or create it. content becomes the entire file: any text not in it is deleted. To change part of a file, readFile it first and send the full new text. Only editable paths are accepted; returns once the file is on disk.", input: object({ path: { type: "string" }, content: { type: "string", description: "The complete new text of the file, not a diff or an addition" } }, ["path", "content"]), run: (api, a: { path: string; content: string }) => api.editFile(a.path, a.content) },
  startReplay: {
    description: "Freeze the current edits as a candidate and replay it on the target moments (default: the whole set) against the base harness. Returns at once; poll getReplay.",
    input: object({ moments: { type: "array", items: { type: "string" } }, start, samples: object({ base: { type: "integer", minimum: 1 }, tiebreak: { type: "integer", minimum: 0 } }, ["base", "tiebreak"]) }),
    run: (api, a: Parameters<Workbench["startReplay"]>[0]) => api.startReplay(a),
  },
  getReplay: { description: "Durable progress of a Replay, its baseline and every sample. Resumes unfinished work whose process died.", input: object({ replay: id }, ["replay"]), run: (api, a: { replay: string }) => api.getReplay(a.replay) },
  runChecks: { description: "Check results per moment and sample, against the baseline, with intent judgments applied, and whether the set passes.", input: object({ replay: id }, ["replay"]), run: (api, a: { replay: string }) => api.runChecks(a.replay) },
  judgeIntent: {
    description: "Record your judgment of the check's plain-language intent for one finished sample. Use the candidate or baseline replay id that getReplay lists.",
    input: object({ replay: id, sample: { type: "integer", minimum: 0 }, met: { type: "boolean" }, reason: { type: "string", minLength: 1 } }, ["replay", "sample", "met", "reason"]),
    run: (api, a: { replay: string; sample: number; met: boolean; reason: string }) => api.judgeIntent(a.replay, a.sample, a.met, a.reason),
  },
  fidelityReport: { description: "The fidelity report of every sample in a Replay: tiers, who answered, divergences and limits.", input: object({ replay: id }, ["replay"]), run: (api, a: { replay: string }) => api.fidelityReport(a.replay) },
  makePatch: { description: "Write the latest candidate's editable changes as a patch plus a result file; with pullRequest, push a branch and open a pull request against the harness repository.", input: object({ pullRequest: { type: "boolean" } }), run: (api, a: { pullRequest?: boolean }) => api.makePatch(a) },
};

export async function serveMcp(api: Workbench): Promise<void> {
  const server = new McpServer({ name: "phoenix-workbench", version: "1.0.0" });
  for (const [name, operation] of Object.entries(OPERATIONS)) {
    server.registerTool(name, { description: operation.description, inputSchema: fromJsonSchema<Record<string, unknown>>(operation.input) }, async (args: Record<string, unknown>) => {
      try {
        const value = await operation.run(api, args as never);
        return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

const USAGE = [
  "Usage: phoenix workbench init --name <workspace> --harness <dir> --moments <dir> --settings <replay-settings.json> [--base <commit>] [--home <dir>]",
  "       phoenix workbench --mcp --workspace <name> [--home <dir>] [--ledger <file>] [--concurrency <n>]",
  `       phoenix workbench <${Object.keys(OPERATIONS).join("|")}> --workspace <name> [--<argument> <value> ...]`,
  "  Arguments that are not strings are given as JSON, for example --ref '{\"moment\":\"m1\"}' --pullRequest true.",
].join("\n");

export async function runWorkbenchCommand(args: string[]): Promise<number> {
  const global = { home: { type: "string" }, workspace: { type: "string" }, ledger: { type: "string" }, concurrency: { type: "string" }, mcp: { type: "boolean" } } as const;
  const [command] = args;
  const home = (value?: string) => resolve(value ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
  if (command === "init") {
    const { values } = parseArgs({ args: args.slice(1), options: { home: { type: "string" }, name: { type: "string" }, harness: { type: "string" }, moments: { type: "string" }, settings: { type: "string" }, base: { type: "string" } } });
    if (!values.name || !values.harness || !values.moments || !values.settings) throw new Error(USAGE);
    const state = await createWorkspace({ home: home(values.home), name: values.name, harness: values.harness, moments: values.moments, settings: values.settings, base: values.base });
    process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    return 0;
  }
  const operation = command && !command.startsWith("-") ? OPERATIONS[command] : undefined;
  if (command && !command.startsWith("-") && !operation) throw new Error(USAGE);
  const options: Record<string, { type: "string" | "boolean" }> = { ...global };
  for (const key of Object.keys(operation?.input.properties ?? {})) options[key] = { type: "string" };
  const { values } = parseArgs({ args: operation ? args.slice(1) : args, options, strict: true });
  if (!values.workspace) throw new Error(USAGE);
  const api = await Workbench.open({ home: home(values.home as string | undefined), workspace: values.workspace as string, ledger: values.ledger as string | undefined, concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency) });
  if (!operation) {
    if (!values.mcp) throw new Error(USAGE);
    await serveMcp(api);
    return 0;
  }
  const input: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(operation.input.properties)) {
    const raw = values[key] as string | undefined;
    if (raw !== undefined) input[key] = (schema as { type?: string }).type === "string" ? raw : JSON.parse(raw);
  }
  const valid = fromJsonSchema(operation.input)["~standard"].validate(input);
  if ("then" in valid) throw new Error("Unexpected asynchronous validation");
  if (valid.issues) throw new Error(`${command}: ${valid.issues.map(i => i.message).join("; ")}`);
  const value = await operation.run(api, input as never);
  process.stdout.write((typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
  return 0;
}
