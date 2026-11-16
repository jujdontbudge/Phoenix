// Plans the reads that snapshot what the session touched: each thread, message and draft it saw,
// and the label list, or for a command-line target the folder list and the session's own
// envelope lists and message reads. Every planned read is declared read-only. Makes no network calls.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { valued } from "./learn.mjs";

const descriptor = JSON.parse(await readFile(new URL("../phoenix-plugin.json", import.meta.url), "utf8"));
const MESSAGE_RESULTS = new Set(["get_message", "send_message", "reply", "forward"]);
const DRAFT_RESULTS = new Set(["create_draft", "update_draft", "get_draft"]);
const HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References"];
let calls = { mcp: [], cli: [] };
let initialized = false;

async function plan(segments) {
  const events = [], commands = [];
  const bodyOf = async (event, segment) => {
    if (!event.body || event.body.content_encoding) return undefined;
    if (!event.body.blob) return event.body.inline;
    if (!/^sha256:[a-f0-9]{64}$/.test(event.body.blob)) throw new Error("Invalid capture blob reference");
    return readFile(join(dirname(segment), "..", "blobs", "sha256", event.body.blob.slice(7)), "utf8");
  };
  for (const segment of segments) {
    for (const line of (await readFile(segment, "utf8")).split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.connector !== descriptor.connector || event.partial) continue;
      if (event.surface === "mcp" && ["call", "result"].includes(event.kind)) events.push({ event, segment });
      if (event.surface === "cli" && event.kind === "call" && !/^(frame|fragment):/.test(event.op ?? "")) {
        let value;
        try { value = JSON.parse(await bodyOf(event, segment) ?? ""); } catch { continue; }
        const argv = event.op === "open" ? value?.meta?.argv : value?.argv;
        if (Array.isArray(argv) && argv.every(a => typeof a === "string")) commands.push(argv);
      }
    }
  }
  events.sort((a, b) => a.event.stream.localeCompare(b.event.stream) || a.event.seq - b.event.seq);
  const threads = new Set(), messages = new Set(), drafts = new Set();
  const add = (set, id) => { if (typeof id === "string" && id) set.add(id); };
  const pending = new Map();
  let used = false;
  for (const { event, segment } of events) {
    const body = await bodyOf(event, segment);
    let message;
    try { message = JSON.parse(body ?? ""); } catch { continue; }
    if (message?.jsonrpc !== "2.0" || !["string", "number"].includes(typeof message.id)) continue;
    const key = JSON.stringify([event.stream, message.id]);
    if (event.kind === "call") {
      if (message.method !== "tools/call" || !descriptor.operations.includes("tools/call:" + message.params?.name)) continue;
      const args = message.params?.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      used = true;
      pending.set(key, message.params.name);
      add(threads, args.threadId); add(messages, args.messageId); add(messages, args.replyToMessageId); add(drafts, args.draftId);
      continue;
    }
    const tool = pending.get(key);
    pending.delete(key);
    if (!tool || message.error || !message.result || message.result.isError) continue;
    let value = message.result.structuredContent;
    if (value === undefined && message.result.content?.length === 1 && message.result.content[0].type === "text") {
      try { value = JSON.parse(message.result.content[0].text); } catch { continue; }
    }
    if (!value || typeof value !== "object") continue;
    add(threads, value.threadId); add(messages, value.messageId);
    if (MESSAGE_RESULTS.has(tool)) add(messages, value.id);
    if (DRAFT_RESULTS.has(tool)) add(drafts, value.id);
    if (tool === "get_thread") add(threads, value.id);
    for (const thread of value.threads ?? []) { add(threads, thread.id); for (const m of thread.messages ?? []) add(messages, m.id); }
    for (const m of value.messages ?? []) { add(messages, m.id); add(threads, m.threadId); }
    for (const d of value.drafts ?? []) { add(drafts, d.id); add(messages, d.messageId); add(threads, d.threadId); }
  }
  const reads = new Map();
  for (const argv of commands) {
    const at = argv.findIndex((word, i) => i > 0 && ((word === "envelope" && argv[i + 1] === "list") || (word === "message" && argv[i + 1] === "read")));
    if (at < 0) continue;
    const [group, action] = argv.slice(at, at + 2);
    const options = [], ids = [];
    for (let i = 1; i < argv.length; i++) {
      if (i === at || i === at + 1) continue;
      const a = argv[i];
      if (["-o", "--output", "-H", "--header"].includes(a)) { i++; continue; }
      if (a.startsWith("--output=") || a.startsWith("--header=") || a === "--preview" || (a === "-p" && group === "message")) continue;
      if (valued(argv, a)) { options.push(a, argv[++i]); continue; }
      if (group === "message" && /^\d+$/.test(a)) ids.push(a); else options.push(a);
    }
    const plan = group === "envelope" ? [["himalaya", group, action, ...options, "-o", "json"]] : ids.map(id => ["himalaya", group, action, "--preview", ...options, "-o", "json", ...HEADERS.flatMap(h => ["-H", h]), id]);
    for (const read of plan) reads.set(JSON.stringify(read), read);
  }
  const cli = commands.length ? [["himalaya", "folder", "list"], ...reads.values()].map(argv => ({ op: "himalaya", args: { argv: ["himalaya", ...argv.slice(1)] } })) : [];
  if (!used) return { mcp: [], cli };
  return { cli, mcp: [
    { op: "tools/call:list_labels", args: {} },
    ...[...threads].map(threadId => ({ op: "tools/call:get_thread", args: { threadId, messageFormat: "FULL_CONTENT" } })),
    ...[...messages].map(messageId => ({ op: "tools/call:get_message", args: { messageId, messageFormat: "RAW" } })),
    ...[...drafts].map(draftId => ({ op: "tools/call:get_draft", args: { draftId, messageFormat: "FULL_CONTENT" } })),
  ] };
}

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
    if (request?.phoenix_plugin !== 1 || !Number.isInteger(request.id) || !request.params || typeof request.params !== "object") throw new Error("Invalid plugin request");
    let value;
    if (request.method === "initialize") {
      const segments = request.params.segments ?? [];
      if (!Array.isArray(segments) || !segments.every(s => typeof s === "string")) throw new Error("segments must be file paths");
      calls = await plan(segments);
      initialized = true;
      value = null;
    } else if (!initialized) throw new Error("Initialize first");
    else if (request.method === "capture" && request.params.phase === "plan") value = { calls: request.params.surface === "cli" ? calls.cli : request.params.surface === "mcp" ? calls.mcp : [] };
    else if (request.method === "capture" && request.params.phase === "complete") value = { collections: [{ entity: "message", complete: false }, { entity: "draft", complete: false }] };
    else {
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "unsupported", reason: "The capture command does not answer " + request.method }));
      continue;
    }
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: "answer", value }));
  } catch (error) {
    console.log(JSON.stringify({ phoenix_plugin: 1, id: request?.id ?? null, status: "execution-failure", reason: error instanceof Error ? error.message : String(error) }));
  }
}
