import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { at: { type: "string" }, "from-beginning": { type: "boolean" }, files: { type: "string" } } });
const fromBeginning = !!values["from-beginning"];
const lines = (await text(process.stdin)).split("\n");
if (lines.at(-1) === "") lines.pop();
const at = fromBeginning ? lines.length : Number(values.at);
if (!Number.isInteger(at) || at < 1 || at > lines.length) throw new Error(`--at must be a line of the session (1-${lines.length})`);
const records = lines.map((line, index) => ({ line: index + 1, record: JSON.parse(line) }));
const created = records[0]?.record;
if (created?.v !== 1 || created.kind !== "session_created") throw new Error("Only fx native session logs (v1 records) are supported");
const start = fromBeginning ? records.find(({ record }) => record.kind === "turn_started") : records.slice(0, at).findLast(({ record }) => record.kind === "turn_started");
if (!start) throw new Error(fromBeginning ? "The session has no turn" : `No turn starts at or before line ${at}; a moment starts at the turn that holds it`);
const user = records.find(({ record }) => record.kind === "item" && record.type === "user" && record.turn === start.record.turn);
if (!user) throw new Error("The turn has no user message");
if (user.record.data.images?.length) throw new Error("The user turn holds images; only text turns can be resumed");

const before = records.slice(0, start.line - 1);
let prefs;
const identities = {};
for (const { record } of before) {
  if (record.kind === "set" && record.key === "prefs") prefs = record.value;
  if (record.kind === "set" && record.key === "tool_identities") Object.assign(identities, record.value);
}
for (const { record } of records) if (record.kind === "set" && record.key === "tool_identities") for (const [name, identity] of Object.entries(record.value)) identities[name] ??= identity;
if (!prefs?.provider || !prefs.model) throw new Error("The session names no provider and LLM before this moment");

const blobs = values.files && existsSync(join(values.files, "blobs")) ? join(values.files, "blobs") : undefined;
const output = result => {
  const hash = /^result-([0-9a-f]{64})\.txt$/.exec(result.artifact_ref ?? "")?.[1];
  if (hash && blobs && existsSync(join(blobs, hash))) return readFileSync(join(blobs, hash), "utf8");
  return hash ? undefined : result.preview ?? "";
};
const route = name => identities[name] ? { connector: identities[name].server, op: identities[name].tool } : { connector: "fx", op: name };
const calls = new Map();
const answers = [];
for (const { line, record } of records) {
  if (record.kind !== "item") continue;
  if (record.type === "tool_call") calls.set(record.data.call_id, record.data);
  if (record.type !== "tool_result") continue;
  const call = calls.get(record.data.call_id);
  if (!call) continue;
  const text = output(record.data);
  if (text === undefined) continue;
  let args;
  try { args = JSON.parse(call.arguments_json); } catch { args = { arguments_json: call.arguments_json }; }
  answers.push({ id: record.data.call_id, line, tool: call.tool_name, ...route(call.tool_name), args, result: { content: [{ type: "text", text }], isError: record.data.status !== "success" }, observed_at: new Date(record.ts).toISOString(), before_cut: line < start.line });
}

const files = new Set();
if (blobs) for (const { line } of before) for (const hash of lines[line - 1].match(/[0-9a-f]{64}/g) ?? []) if (existsSync(join(blobs, hash))) files.add(`blobs/${hash}`);

process.stdout.write(JSON.stringify({
  phoenix_session_moment: 1,
  at: fromBeginning ? user.line : at, turn: start.line, from_beginning: fromBeginning, cut_lines: start.line - 1, prompt: user.record.data.text, time: new Date(start.record.ts).toISOString(), cwd: created.workspace, session: created.id,
  model: { provider: prefs.provider, id: prefs.model, ...(prefs.effort ? { effort: prefs.effort } : {}) },
  loadout: { identities },
  answers,
  read_only: { fx: ["read_file", "grep_files", "glob_files", "read_tool_result"] },
  in_box: { fx: ["read_file", "write_file", "edit_file", "grep_files", "glob_files"] },
  shell: { fx: { shell: { command: "command", cwd: "cwd" } } },
  files: [...files].sort(),
}) + "\n");
