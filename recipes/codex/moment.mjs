import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { toolSchema } from "./declaration.mjs";

const VERSIONS = ["0.167.0", "0.169.0"];
const SEPARATOR = "\n\n--- project-doc ---\n\n";
const { values } = parseArgs({ options: { at: { type: "string" }, "from-beginning": { type: "boolean" } } });
const fromBeginning = !!values["from-beginning"];
const lines = (await text(process.stdin)).split("\n");
if (lines.at(-1) === "") lines.pop();
let at = fromBeginning ? undefined : Number(values.at);
if (!fromBeginning && (!Number.isInteger(at) || at < 1 || at > lines.length)) throw new Error(`--at must be a line of the session (1-${lines.length})`);
const rows = lines.map((line, index) => ({ line: index + 1, row: JSON.parse(line) }));
const meta = rows[0]?.row.type === "session_meta" ? rows[0].row.payload : undefined;
if (!meta || !VERSIONS.includes(meta.cli_version)) throw new Error(`Only Codex sessions from versions ${VERSIONS.join(", ")} are supported`);
if (meta.account_scoped !== true && typeof meta.creator_account_id !== "string") throw new Error("Only sessions that used a ChatGPT login can resume; this one names no ChatGPT account");

const turns = [];
let message;
for (const entry of rows) {
  const { row } = entry;
  if (row.type === "response_item" && row.payload?.type === "message" && row.payload.role === "user") message = entry;
  if (message && row.type === "event_msg" && row.payload?.type === "item_completed" && row.payload.item?.type === "UserMessage") turns.push({ message, turn: entry });
}
const found = fromBeginning ? turns[0] : turns.findLast(({ message }) => message.line <= at);
if (!found) throw new Error(fromBeginning ? "The session has no user message" : `No user message at or before line ${at}; a moment starts at the user turn that holds it`);
at ??= found.message.line;
({ message } = found);
const { turn } = found;
const content = turn.row.payload.item.content ?? [];
if (content.some(block => block.type !== "text")) throw new Error("The user turn holds images or files; only text turns can be resumed");
const prompt = content.map(block => block.text).join("");
const before = rows.slice(0, message.line - 1);

let context, settings = {};
const world = {};
for (const { row } of before) {
  if (row.type === "turn_context") context = row.payload;
  if (row.type === "event_msg" && row.payload?.type === "thread_settings_applied") settings = row.payload.thread_settings ?? {};
  if (row.type === "world_state") for (const [key, value] of Object.entries(row.payload?.state ?? {})) if (value !== null) world[key] = value;
}
if (!context?.model) throw new Error("The session names no LLM before this moment");
const agents = world.agents_md?.text ?? "";
const split = agents.indexOf(SEPARATOR);

const plain = name => name.replace(/[^A-Za-z0-9_]/g, "_");
const servers = new Map();
const tools = server => servers.get(server) ?? servers.set(server, new Map()).get(server);
const readOnly = {};
const answers = [];
const shellResult = (output, exit_code) => ({ output, exit_code, content: [{ type: "text", text: output }], structuredContent: { output, exit_code }, isError: exit_code !== 0 });
const pathOf = cwd => typeof cwd === "string" && cwd.startsWith("file://") ? decodeURIComponent(new URL(cwd).pathname) : cwd;
for (const { line, row } of rows) {
  const item = row.type === "event_msg" && row.payload?.type === "item_completed" ? row.payload.item : undefined;
  const beforeCut = line < message.line;
  if (item?.type === "McpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
    const failed = item.status !== "completed" || !item.result;
    const result = failed ? { content: [{ type: "text", text: typeof item.error === "string" ? item.error : JSON.stringify(item.error ?? item.result ?? "failed") }], isError: true } : item.result;
    answers.push({ id: item.id, line, tool: `${item.server}.${item.tool}`, connector: item.server, op: item.tool, args: item.arguments ?? {}, result, observed_at: row.timestamp, before_cut: beforeCut });
    if (!tools(item.server).has(item.tool)) tools(item.server).set(item.tool, { name: item.tool, description: "", inputSchema: { type: "object" } });
    if (item.readOnlyHint === true && !(readOnly[item.server] ??= []).includes(item.tool)) readOnly[item.server].push(item.tool);
  }
  if (item?.type === "CommandExecution" && Array.isArray(item.command) && typeof item.command.at(-1) === "string") {
    answers.push({ id: item.id, line, tool: "codex-shell.exec", connector: "codex-shell", op: "exec", args: { command: item.command.at(-1), cwd: pathOf(item.cwd) }, result: shellResult(item.aggregated_output ?? "", item.exit_code ?? 0), observed_at: row.timestamp, before_cut: beforeCut });
  }
}
for (const { row } of rows) {
  const payload = row.payload;
  if (row.type === "response_item" && payload?.type === "additional_tools") {
    for (const namespace of payload.tools ?? []) for (const [server, known] of servers) {
      if (namespace.type !== "namespace" || ![`mcp__${plain(server)}`, `mcp__${plain(server)}_direct`].includes(namespace.name)) continue;
      for (const tool of namespace.tools ?? []) if (tool.type === "function") known.set(tool.name, { name: tool.name, description: tool.description ?? "", inputSchema: tool.parameters ?? { type: "object" } });
    }
  }
  if (row.type === "response_item" && ["custom_tool_call_output", "function_call_output"].includes(payload?.type) && Array.isArray(payload.output)) {
    for (const part of payload.output) {
      let listed;
      try { listed = JSON.parse(part.text ?? ""); } catch { continue; }
      if (!Array.isArray(listed)) continue;
      for (const entry of listed) for (const [server, known] of servers) {
        const prefix = `mcp__${plain(server)}__`;
        if (typeof entry?.name !== "string" || !entry.name.startsWith(prefix) || typeof entry.description !== "string") continue;
        const name = entry.name.slice(prefix.length);
        if (!known.get(name)?.description) known.set(name, { name, ...toolSchema(entry.name, entry.description) });
      }
    }
  }
}

process.stdout.write(JSON.stringify({
  phoenix_session_moment: 1,
  at, turn: turn.line, from_beginning: fromBeginning, cut_lines: message.line - 1, prompt, time: turn.row.timestamp, cwd: context.cwd,
  model: { provider: "chatgpt", id: context.model, ...(context.effort ? { thinking: context.effort } : {}) },
  loadout: {
    session: meta.id, started: meta.timestamp, cwd: context.cwd, directories: [...new Set(answers.filter(answer => answer.connector === "codex-shell").map(answer => answer.args.cwd).filter(cwd => typeof cwd === "string"))], shell: world.environments?.environments?.local?.shell ?? null, timezone: world.environments?.timezone ?? null,
    agents: { global: split < 0 ? agents : agents.slice(0, split), project: split < 0 ? "" : agents.slice(split + SEPARATOR.length), directory: world.agents_md?.directory ?? null },
    settings: { provider: meta.model_provider, model: context.model, effort: context.effort ?? settings.reasoning_effort ?? null, summary: settings.reasoning_summary ?? null, personality: settings.personality ?? null, service_tier: settings.service_tier ?? null },
    mcp: Object.fromEntries([...servers].map(([server, known]) => [server, [...known.values()]])),
  },
  answers,
  read_only: readOnly,
  shell: { "codex-shell": { exec: { command: "command", cwd: "cwd", output: "/structuredContent/output", exit: "/structuredContent/exit_code" } } },
}) + "\n");
