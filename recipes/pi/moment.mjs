import { readFileSync } from "node:fs";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { ADAPTER, METADATA, adapterCall, isProxy, withoutNulls } from "./adapter.mjs";

const { values } = parseArgs({ options: { at: { type: "string" }, "from-beginning": { type: "boolean" }, change: { type: "string", multiple: true } } });
const lines = (await text(process.stdin)).split("\n");
if (lines.at(-1) === "") lines.pop();
const fromBeginning = !!values["from-beginning"];
const at = fromBeginning ? undefined : Number(values.at);
if (!fromBeginning && (!Number.isInteger(at) || at < 1 || at > lines.length)) throw new Error(`--at must be a line of the session (1-${lines.length})`);
const entries = lines.map((line, index) => ({ line: index + 1, entry: JSON.parse(line) }));
if (entries[0]?.entry.type !== "session" || entries[0].entry.version !== 3) throw new Error("Only pi session format v3 is supported");
const edits = [];
for (const change of values.change ?? []) {
  const [line, file] = [Number(change.slice(0, change.indexOf("="))), change.slice(change.indexOf("=") + 1)];
  const found = entries[line - 1];
  if (!found || found.entry.type !== "message" || found.entry.message.role !== "toolResult") throw new Error(`--change ${line}: that line is not a tool answer`);
  found.entry.message = { ...found.entry.message, content: [{ type: "text", text: readFileSync(file, "utf8") }] };
  edits.push({ line, text: JSON.stringify(found.entry) });
}
const isUser = ({ entry }) => entry.type === "message" && entry.message.role === "user";
const turn = fromBeginning ? entries.find(isUser) : entries.slice(0, at).findLast(isUser);
if (!turn) throw new Error(fromBeginning ? "The session has no user message" : `No user message at or before line ${at}; a moment starts at the user turn that holds it`);
const content = turn.entry.message.content;
if (Array.isArray(content) && content.some(block => block.type !== "text")) throw new Error("The user turn holds images or files; only text turns can be resumed");
const prompt = typeof content === "string" ? content : content.map(block => block.text).join("");

const before = entries.slice(0, turn.line - 1);
let sections = {};
const tools = new Map();
let provider, model, thinking;
const system = message => {
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    if (value === null) delete sections[name];
    else sections[name] = value;
  }
  for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
};
for (const { entry } of before) {
  if (entry.type === "model_change") { provider = entry.provider; model = entry.modelId; }
  if (entry.type === "thinking_level_change") thinking = entry.thinkingLevel;
  if (entry.type === "compaction" && entry.systemMessage) { sections = {}; tools.clear(); system(entry.systemMessage); }
  if (entry.type === "message" && entry.message.role === "system") system(entry.message);
  if (entry.type === "message" && entry.message.role === "assistant" && entry.message.provider) { provider = entry.message.provider; model = entry.message.model; }
}
if (!provider || !model) throw new Error("The session names no provider and model before this moment");

const calls = new Map();
const results = new Map();
const direct = new Map();
const adapter = { servers: [], tools: {} };
const addServer = server => { if (typeof server === "string" && !adapter.servers.includes(server)) adapter.servers.push(server); };
for (const name of /^Servers: (.+)$/m.exec(tools.get("mcp")?.description ?? "")?.[1]?.split(", ") ?? []) addServer(name.trim());
for (const { entry } of entries) {
  if (entry.type !== "message") continue;
  const { role, content, toolName, toolCallId, details } = entry.message;
  if (role === "assistant" && Array.isArray(content)) for (const block of content) if (block.type === "toolCall") calls.set(block.id, block);
  if (role !== "toolResult" || !details) continue;
  results.set(toolCallId, details);
  addServer(details.server);
  if (details.mode === "list" && Array.isArray(details.tools)) for (const name of details.tools) if (name.startsWith(`${details.server}_`)) adapter.tools[name] ??= { server: details.server, tool: name.slice(details.server.length + 1) };
  if (details.mode === "describe" && details.tool?.name && details.tool.originalName && details.server) adapter.tools[details.tool.name] = { server: details.server, tool: details.tool.originalName };
  const call = calls.get(toolCallId);
  if (details.mode === "call" && details.server && typeof details.tool === "string" && typeof call?.arguments?.tool === "string") adapter.tools[call.arguments.tool] = { server: details.server, tool: details.tool };
  if (details.mode === undefined && details.server && typeof details.tool === "string") direct.set(toolName, { connector: details.server, op: details.tool });
}
const proxies = new Set([...tools.values(), ...calls.values()].filter(isProxy).map(tool => tool.name));
for (const [id, details] of results) if (details.mode === "call" && calls.get(id)) proxies.add(calls.get(id).name);
const route = name => {
  if (proxies.has(name)) return { connector: ADAPTER, op: name, adapter: { proxy: true } };
  const own = tools.get(name)?.phoenix;
  if (own?.connector && own.op) return { connector: own.connector, op: own.op };
  const named = /^mcp__(.+?)__(.+)$/.exec(name);
  return direct.get(name) ?? (named ? { connector: named[1], op: named[2] } : { connector: "pi", op: name });
};
const answers = [];
for (const { line, entry } of entries) {
  if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
  const call = calls.get(entry.message.toolCallId);
  if (!call) continue;
  const { content, details, isError } = entry.message;
  const reached = proxies.has(call.name) ? adapterCall(call.name, call.arguments, adapter) : { ...route(call.name), args: withoutNulls(call.arguments ?? {}) };
  answers.push({ id: entry.message.toolCallId, line, tool: entry.message.toolName, connector: reached.connector, op: reached.op, args: reached.args, result: { content, isError: !!isError, ...(details ? { details } : {}) }, observed_at: entry.timestamp, before_cut: line < turn.line });
}

process.stdout.write(JSON.stringify({
  phoenix_session_moment: 1,
  at: at ?? turn.line, turn: turn.line, from_beginning: fromBeginning, edits, cut_lines: turn.line - 1, prompt, time: turn.entry.timestamp, cwd: entries[0].entry.cwd,
  model: { provider, id: model, ...(thinking ? { thinking } : {}) },
  loadout: { sections, harness_sections: ["addendum"], tools: [...tools.values()].map(tool => ({ ...tool, ...route(tool.name) })), adapter },
  answers,
  read_only: { pi: ["read", "grep", "find", "ls"], [ADAPTER]: METADATA },
  in_box: { pi: ["read", "write", "edit", "ls", "grep", "find"] },
  shell: { pi: { bash: { command: "command", exit: "isError" } } },
}) + "\n");
