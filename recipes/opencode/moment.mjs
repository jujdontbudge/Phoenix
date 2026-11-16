import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

const STANDS_IN = ["bash", "read", "glob", "grep", "edit", "write", "apply_patch", "webfetch", "websearch", "skill", "task", "question"];
const NATIVE = ["todowrite", "invalid"];
const IN_BOX = ["read", "glob", "grep", "edit", "write", "apply_patch"];
const { values } = parseArgs({ options: { at: { type: "string" } } });
const at = Number(values.at);
const lines = (await text(process.stdin)).split("\n");
if (lines.at(-1) === "") lines.pop();
if (!Number.isInteger(at) || at < 2 || at > lines.length) throw new Error("--at must be a message line of the session (2-" + lines.length + ")");
const header = JSON.parse(lines[0]);
if (header.opencode_session !== 1) throw new Error("Make the session file with recipes/opencode/export.mjs");
const messages = lines.slice(1).map((line, index) => ({ line: index + 2, ...JSON.parse(line) }));
const target = messages.find(m => m.line === at);
const turn = messages.filter(m => m.line <= at).findLast(m => m.info.role === "user");
if (!turn) throw new Error("No user message at or before line " + at);
const texts = turn.parts.filter(p => p.type === "text" && !p.synthetic);
if (turn.parts.some(p => p.type === "file")) throw new Error("The user turn holds files; only text turns can be resumed");
const prompt = texts.map(p => p.text).join("\n");
const midTurn = target.info.role === "assistant";
const at_message = midTurn ? target : turn;
const model = midTurn
  ? { provider: target.info.providerID, id: target.info.modelID }
  : { provider: turn.info.model?.providerID, id: turn.info.model?.modelID };
if (!model.provider || !model.id) throw new Error("The session names no LLM at this moment");
const variant = turn.info.model?.variant ?? turn.info.variant ?? header.info.model?.variant;

const used = new Set();
const answers = [];
for (const message of messages) for (const part of message.parts) {
  if (part.type !== "tool" || !["completed", "error"].includes(part.state?.status)) continue;
  used.add(part.tool);
  if (NATIVE.includes(part.tool)) continue;
  const { status, input, output, title, metadata, error, attachments } = part.state;
  answers.push({ id: part.callID, line: message.line, tool: part.tool, connector: "opencode", op: part.tool, args: input ?? {}, result: status === "error" ? { isError: true, content: [{ type: "text", text: error ?? "" }] } : { content: [{ type: "text", text: output ?? "" }], structuredContent: { title: title ?? "", metadata: metadata ?? {}, ...(attachments?.length ? { attachments } : {}) } }, observed_at: new Date(part.state.time?.end ?? message.info.time.created).toISOString(), before_cut: message.line < at_message.line });
}
const unknown = [...used].filter(name => !STANDS_IN.includes(name) && !NATIVE.includes(name));
if (unknown.length) throw new Error("The session used tools OpenCode does not build in (" + unknown.join(", ") + "); the recipe cannot stand in for MCP or plugin tools yet");

process.stdout.write(JSON.stringify({
  phoenix_session_moment: 1,
  at, turn: turn.line, cut_lines: at_message.line - 1, prompt, time: new Date(at_message.info.time.created).toISOString(), cwd: header.info.directory,
  model: { provider: model.provider, id: model.id },
  box: { session: header.info.id, directory: header.info.directory, cut_time: at_message.info.time.created, agent: turn.info.agent ?? "build", ...(variant ? { variant } : {}), continue: midTurn },
  loadout: { tools: STANDS_IN, in_box: IN_BOX, shell: ["bash"] },
  answers,
  read_only: { opencode: ["read", "glob", "grep", "webfetch", "websearch", "skill"] },
  in_box: { opencode: IN_BOX },
  shell: { opencode: { bash: { command: "command", cwd: "workdir", output: "/structuredContent/metadata/output", exit: "/structuredContent/metadata/exit" } } },
}) + "\n");
