import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TraceEvent } from "@phoenix/formats";
import { HttpModelProvider } from "@phoenix/model";
import { decodeMcp, encodeMcp } from "@phoenix/wire";
import { answerCall, buildIndex, replayCtx, SimulatorStore, toCall, type ConnectorPolicy } from "./index.ts";

async function replay(t: TestContext, version: string, schema: object, recorded: object, replies: readonly object[]) {
  const root = await mkdtemp(join(tmpdir(), "phoenix-simulator-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let response = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(replies[Math.min(response++, replies.length - 1)]) }] }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new HttpModelProvider({ model: "test-simulator", endpoint: `http://127.0.0.1:${address.port}/responses`, dialect: "responses", maxOutputTokens: 1024 }, {});
  const policy = (): ConnectorPolicy => ({ allow_synthesized: true, read_only: [{ op: "tools/call:lookup", source: "plugin" }] });
  const meta = {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
    { jsonrpc: "2.0", id: 1, result: { ...(version === "2026-07-28" ? { resultType: "complete" } : {}), tools: [{ name: "lookup", inputSchema: { type: "object" }, outputSchema: schema }] } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup", arguments: { query: "known" }, _meta: meta } },
    { jsonrpc: "2.0", id: 2, result: recorded },
  ];
  const events: TraceEvent[] = messages.map((message, seq) => ({
    v: 1, capture: "protocol-evidence", stream: "lookup", seq, kind: seq % 2 ? "result" : "call",
    surface: "mcp", layer: "agent", connector: "lookup", route: "tap",
    ts: { wall: "2026-11-15T15:00:00.000Z", mono: String(seq) }, body: { inline: JSON.stringify(message) },
  }));
  const index = await buildIndex(events, { body: async event => {
    assert.ok(event.body && "inline" in event.body);
    return Buffer.from(event.body.inline);
  }, policy });
  const ctx = replayCtx(index, policy, undefined, { moment: "protocol-review", provider, improverModel: "test-improver", store: new SimulatorStore(root), clock: () => index.cutTime });
  const args = { query: "unseen" };
  return answerCall(toCall({ surface: "mcp", connector: "lookup", op: "tools/call:lookup", args, raw: { body: encodeMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lookup", arguments: args, _meta: meta } }) } }, policy()), ctx);
}

test("simulator accepts an MCP 2026 tool's declared array output", async t => {
  const recorded = { resultType: "complete", content: [{ type: "text", text: '["known"]' }], structuredContent: ["known"] };
  const expected = { resultType: "complete", content: [{ type: "text", text: '["unseen"]' }], structuredContent: ["unseen"] };
  const result = await replay(t, "2026-07-28", { type: "array", items: { type: "string" } }, recorded, [expected]);
  assert.ok("answer" in result, `a schema-valid 2026 response must be served, not ${JSON.stringify(result)}`);
  assert.equal(result.answer.provenance, "synthesized");
  const decoded = decodeMcp(result.answer.raw.body);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.value.result, expected);
});

test("simulator retries invalid MCP content annotations instead of serving them", async t => {
  const expected = { content: [{ type: "text", text: '{"ready":true}' }], structuredContent: { ready: true } };
  const invalid = { ...expected, content: [{ ...expected.content[0], annotations: { priority: "urgent" } }] };
  const schema = { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false };
  const result = await replay(t, "2025-11-25", schema, expected, [invalid, expected]);
  assert.ok("answer" in result);
  const decoded = decodeMcp(result.answer.raw.body);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.value.result, expected, "annotations.priority must be a number in [0, 1], so the invalid first answer must never be served");
});

test("simulator retries a resource link with a non-string description", async t => {
  const link = { type: "resource_link", name: "status", uri: "file:///reports/status.json" };
  const recorded = { content: [link], structuredContent: { ready: true } };
  const expected = { ...recorded, content: [{ ...link, description: "Latest status" }] };
  const invalid = { ...recorded, content: [{ ...link, description: 42 }] };
  const schema = { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false };
  const result = await replay(t, "2025-11-25", schema, recorded, [invalid, expected]);
  assert.ok("answer" in result);
  const decoded = decodeMcp(result.answer.raw.body);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.value.result, expected, "resource link descriptions must be strings, so the invalid first answer must never be served");
});
