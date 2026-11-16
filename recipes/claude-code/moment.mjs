import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { CONNECTOR, NATIVE, READ_ONLY, callArgs, mcpName, mendSchema, route } from "./tools.mjs";

const { values } = parseArgs({ options: { at: { type: "string" }, "from-beginning": { type: "boolean" } } });
const fromBeginning = !!values["from-beginning"];
const lines = (await text(process.stdin)).split("\n");
if (lines.at(-1) === "") lines.pop();
const at = fromBeginning ? undefined : Number(values.at);
if (!fromBeginning && (!Number.isInteger(at) || at < 1 || at > lines.length)) throw new Error("--at must be a line of the session (1-" + lines.length + ")");
const entries = lines.map((line, index) => ({ line: index + 1, entry: JSON.parse(line) }));
const typed = ({ entry }) => {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  const content = entry.message?.content;
  return typeof content === "string" || (Array.isArray(content) && content.length > 0 && !content.some(block => block.type === "tool_result"));
};
const turn = fromBeginning ? entries.find(typed) : entries.slice(0, at).findLast(typed);
if (!turn) throw new Error(fromBeginning ? "The session has no user message" : "No user message at or before line " + at + "; a moment starts at the user turn that holds it");
const content = turn.entry.message.content;
if (Array.isArray(content) && content.some(block => block.type !== "text")) throw new Error("The user turn holds images or files; only text turns can be resumed");
const prompt = typeof content === "string" ? content : content.map(block => block.text).join("\n");
let cut = turn.line - 1;
while (cut > 0 && entries[cut - 1].entry.type === "queue-operation") cut--;
const before = entries.slice(0, cut);
const answered = ({ entry }) => entry.type === "assistant" && !entry.isSidechain && entry.message?.model && entry.message.model !== "<synthetic>";
const seen = fromBeginning ? entries.slice(0, entries.findIndex((item, index) => index >= cut && answered(item)) + 1) : before;

const assistant = seen.findLast(answered);
if (!assistant) throw new Error("The session names no LLM before this moment");
const shapes = new Map(seen.filter(({ entry }) => entry.type === "api-request-shape").map(({ entry }) => [entry.shapeHash, entry.shape]));
const request = seen.findLast(({ entry }) => entry.type === "api-request" && shapes.has(entry.shapeHash));
if (!request) throw new Error("The session holds no recorded LLM request before this moment; Claude Code 2.1.301 or later records them");
const shape = shapes.get(request.entry.shapeHash);
const snapshot = seen.findLast(({ entry }) => entry.type === "attachment" && entry.attachment?.type === "prompt_snapshot")?.entry.attachment;
const blocks = shape.system.map(block => block.text);
const system = snapshot?.cliPrefix !== undefined && blocks[0] === snapshot.cliPrefix ? blocks.slice(1) : blocks.slice(/^You are (Claude Code|a Claude agent)\b/.test(blocks[0] ?? "") ? 1 : 0);

const definitions = new Map();
const define = (tool, always) => { if (mcpName(tool.name) && tool.input_schema) definitions.set(tool.name, { description: tool.description ?? "", input_schema: mendSchema(tool.input_schema), always }); };
const records = cutOff => entries.filter(({ line }) => cutOff(line));
for (const window of [line => line > cut, line => line <= cut]) for (const { entry } of records(window)) {
  if (entry.type === "api-request-shape") for (const tool of entry.shape.tools ?? []) define(tool, !tool.defer_loading);
  if (entry.type === "attachment" && entry.attachment?.type === "deferred_tools_record") for (const tool of entry.attachment.entries ?? []) define(tool, false);
}
for (const tool of shape.tools ?? []) define(tool, !tool.defer_loading);

const uses = new Map();
const answers = [];
const world = new Map();
const written = new Set();
const known = path => world.has(path) && world.get(path) !== null;
for (const { line, entry } of entries) {
  if (entry.isSidechain) continue;
  const blocks = entry.message?.content;
  if (entry.type === "assistant" && Array.isArray(blocks)) for (const block of blocks) if (block.type === "tool_use") uses.set(block.id, block);
  if (entry.type !== "user" || !Array.isArray(blocks)) continue;
  for (const block of blocks) {
    const use = block.type === "tool_result" && uses.get(block.tool_use_id);
    if (!use || NATIVE.includes(use.name)) continue;
    const { connector, op } = route(use.name);
    const tur = entry.toolUseResult;
    const result = { content: Array.isArray(block.content) ? block.content : [{ type: "text", text: String(block.content ?? "") }], isError: !!block.is_error, ...(connector === CONNECTOR ? { is_error: !!block.is_error, ...(tur !== undefined ? { toolUseResult: tur, structuredContent: { toolUseResult: tur } } : {}) } : {}) };
    answers.push({ id: use.id, line, tool: use.name, connector, op, args: connector === CONNECTOR ? callArgs(use.name, use.input) : use.input ?? {}, result, observed_at: entry.timestamp, before_cut: line <= cut });
    if (block.is_error || !tur || typeof tur !== "object") continue;
    const path = use.input?.file_path ?? tur.filePath ?? tur.file?.filePath;
    if (typeof path !== "string" || !path.startsWith("/")) continue;
    const after = line > cut;
    if (after && (written.has(path) || known(path))) continue;
    if (use.name === "Read" && tur.type === "text" && tur.file?.startLine === 1 && tur.file.numLines >= tur.file.totalLines) world.set(path, tur.file.content);
    else if (use.name === "Edit" && typeof tur.originalFile === "string") {
      if (after) world.set(path, tur.originalFile);
      else world.set(path, tur.replaceAll ? tur.originalFile.split(tur.oldString).join(tur.newString) : tur.originalFile.replace(tur.oldString, () => tur.newString));
    } else if (use.name === "Write" && typeof tur.content === "string") {
      if (after) { if (typeof tur.originalFile === "string") world.set(path, tur.originalFile); }
      else world.set(path, tur.content);
    } else if (!after && ["Edit", "Write", "NotebookEdit"].includes(use.name)) world.set(path, null);
    if (after && ["Edit", "Write", "NotebookEdit"].includes(use.name)) written.add(path);
  }
}

const offered = new Set((shape.tools ?? []).map(tool => tool.name).filter(name => mcpName(name)));
for (const { entry } of seen) {
  if (entry.type !== "attachment" || entry.attachment?.type !== "deferred_tools_delta") continue;
  for (const name of entry.attachment.removedNames ?? []) offered.delete(name);
  for (const name of entry.attachment.addedNames ?? []) if (mcpName(name)) offered.add(name);
}
const mcp = {};
for (const name of offered) {
  const [, server, tool] = mcpName(name);
  (mcp[server] ??= []).push({ name: tool, ...(definitions.get(name) ?? { description: "", input_schema: { type: "object" }, always: false }) });
}

process.stdout.write(JSON.stringify({
  phoenix_session_moment: 1,
  at: at ?? turn.line, turn: turn.line, from_beginning: fromBeginning, cut_lines: cut, prompt, time: turn.entry.timestamp, cwd: turn.entry.cwd,
  model: { provider: "anthropic", id: assistant.entry.message.model },
  box: { session: turn.entry.sessionId, cwd: turn.entry.cwd, started: entries.find(({ entry }) => entry.timestamp)?.entry.timestamp, ...(turn.entry.entrypoint ? { entrypoint: turn.entry.entrypoint } : {}), ...(assistant.entry.effort ? { effort: assistant.entry.effort } : {}) },
  loadout: { system, mcp, tools: (shape.tools ?? []).map(tool => tool.name), world: [...world].filter(([, content]) => typeof content === "string" && content.length <= 1 << 20).map(([path, content]) => ({ path, content })) },
  answers,
  read_only: { [CONNECTOR]: READ_ONLY },
  shell: { [CONNECTOR]: { Bash: { command: "command", output: "/structuredContent/toolUseResult/stdout", exit: "isError" } } },
}) + "\n");
