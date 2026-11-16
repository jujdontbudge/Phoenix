// The working copy, served to a replay over the plugin protocol (spec/plugin.md).
// Sentry's own MCP server answers each call; its Sentry API calls go to the copy in copy.mjs, never to Sentry.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { createCopy } from "./copy.mjs";
import { startSentryServer } from "./server.mjs";

let copy;
let server;

function results(text) {
  try {
    const data = JSON.parse(text);
    const answers = Array.isArray(data) ? data : data?.answers;
    if (!Array.isArray(answers)) throw new Error("The snapshot must be a list of tool answers, or a session moment with answers");
    return answers.map(answer => answer?.result);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === "result" && typeof event.body?.inline === "string").map(event => JSON.parse(event.body.inline).result);
}

function snapshotLines(path) {
  const lines = results(readFileSync(path, "utf8")).flatMap(result => result?._meta?.["phoenix/sentry-api"] ?? []);
  if (!lines.length) throw new Error("The snapshot holds no Sentry API replies; take it with phoenix-sentry-snapshot");
  return lines;
}

async function initialize(params) {
  if (typeof params.snapshot !== "string") throw new Error("The Sentry copy needs a snapshot");
  copy = createCopy(snapshotLines(params.snapshot));
  const api = createServer(async (request, response) => {
    const body = await text(request);
    const answer = copy.handle(request.method, request.url, body || undefined);
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(answer.body);
  });
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  server = await startSentryServer({ mode: "copy", token: "phoenix-working-copy", copy: `http://127.0.0.1:${api.address().port}` });
  return null;
}

async function call(params) {
  const message = JSON.parse(Buffer.from(params.raw.body, "base64").toString("utf8"));
  if (message.method !== "tools/call" || typeof message.params?.name !== "string") return { status: "unsupported", reason: "The Sentry copy answers tool calls only" };
  copy.begin(params.now, recordedNoteId(params.recorded));
  let answer, misses;
  try { answer = await server.request("tools/call", { name: message.params.name, arguments: message.params.arguments ?? {} }); }
  finally { misses = copy.end(); }
  if (misses.length) return { status: "unsupported", reason: `The Sentry copy cannot answer this like Sentry would: ${misses.join("; ")}` };
  const { jsonrpc, id: _, ...outcome } = answer;
  return { status: "answer", value: { body: Buffer.from(JSON.stringify({ jsonrpc, id: message.id, ...outcome })).toString("base64") } };
}

// When the engine runs a recorded write against the copy, it also sends the recorded answer. A note that write added
// takes the id the agent was given, so later reads show the note the agent knows.
function recordedNoteId(recorded) {
  try {
    const result = JSON.parse(Buffer.from(recorded?.body ?? "", "base64").toString("utf8")).result;
    const id = JSON.parse(result.content.map(part => part.text ?? "").join("")).note?.id;
    return typeof id === "string" ? id : undefined;
  } catch { return undefined; }
}

const reply = (id, outcome) => process.stdout.write(JSON.stringify({ phoenix_plugin: 1, id, ...outcome }) + "\n");
let tail = Promise.resolve();
createInterface({ input: process.stdin }).on("line", line => {
  tail = tail.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      if (request?.phoenix_plugin !== 1 || !Number.isInteger(request.id) || !request.params || typeof request.params !== "object") throw new Error("Invalid plugin request");
      if (request.method === "initialize") return reply(request.id, { status: "answer", value: await initialize(request.params) });
      if (!server) throw new Error("Initialize first");
      if (request.method === "call") return reply(request.id, await call(request.params));
      if (request.method === "state") return reply(request.id, { status: "answer", value: copy.state() });
      reply(request.id, { status: "unsupported", reason: `The Sentry copy has no ${request.method}` });
    } catch (error) {
      reply(request?.id ?? null, { status: "execution-failure", reason: error instanceof Error ? error.message : String(error) });
    }
  });
}).on("close", async () => { await tail; await server?.close(); process.exit(0); });
