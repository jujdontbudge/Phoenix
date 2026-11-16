import assert from "node:assert/strict";
import test from "node:test";
import type { TraceEvent } from "@phoenix/formats";
import { answerCall, buildIndex, replayCtx, toCall, type ConnectorPolicy } from "./index.ts";

test("S2: a write without an argument id must not invent missing entities", async () => {
  const policy = (): ConnectorPolicy => ({
    read_only: ["tools/call:list_events", "tools/call:get_event"].map(op => ({ op, source: "plugin" })),
    entity_map: {
      "tools/call:list_events": { kind: "list", entity: "event", id_path: "/id", items_path: "", complete: "unpaginated" },
      "tools/call:update_current_event": { kind: "update", entity: "event", id_path: "/id", items_path: "" },
      "tools/call:get_event": { kind: "get", entity: "event", id_path: "/id", items_path: "" },
    },
  });
  const events: TraceEvent[] = [];
  for (const [name, args, value] of [
    ["list_events", {}, [{ id: "a", title: "First" }, { id: "b", title: "Second" }]],
    ["update_current_event", { title: "Updated" }, { id: "a", title: "Updated" }],
  ] as const) {
    const id = events.length;
    const messages = [
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } },
    ];
    for (const [part, message] of messages.entries()) {
      const seq = events.length;
      events.push({ v: 1, capture: "overlay-proof", stream: "calendar", seq, ts: { wall: "2026-11-15T12:00:00.000Z", mono: String(seq + 1) },
        kind: part === 0 ? "call" : "result", connector: "calendar", surface: "mcp", body: { inline: JSON.stringify(message) + "\n" } });
    }
  }
  const index = await buildIndex(events, { policy, body: async event => {
    assert.ok(event.body && "inline" in event.body);
    return Buffer.from(event.body.inline);
  } });
  const ctx = replayCtx(index, policy);
  const call = (name: string, args: unknown) => toCall({ surface: "mcp", connector: "calendar", op: `tools/call:${name}`, args,
    raw: { body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name, arguments: args } }) + "\n") } }, policy());
  assert.ok("answer" in await answerCall(call("list_events", {}), ctx));
  assert.ok("answer" in await answerCall(call("update_current_event", { title: "Updated" }), ctx));
  const result = await answerCall(call("get_event", { id: "b" }), ctx);
  const value = "answer" in result ? JSON.parse(JSON.parse(Buffer.from(result.answer.raw.body).toString()).result.content[0].text) : undefined;
  assert.notEqual(value, null, "invalidating unknown write targets must not turn a previously observed entity into a proven absence");
});

test("S3: complete lists support declared nested JSON Pointer filters", async () => {
  const policy = (): ConnectorPolicy => ({
    read_only: [{ op: "tools/call:list_events", source: "plugin" }],
    entity_map: {
      "tools/call:list_events": { kind: "list", entity: "event", id_path: "/id", items_path: "", complete: "unpaginated",
        filters: [{ arg: "/filter/title", field: "/title", match: "equality" }] },
    },
  });
  const items = [{ id: "a", title: "First" }, { id: "b", title: "Second" }];
  const raw = (args: unknown) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_events", arguments: args } }) + "\n");
  const messages = [raw({}).toString(), JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(items) }] } }) + "\n"];
  const events: TraceEvent[] = messages.map((body, seq) => ({ v: 1, capture: "overlay-proof", stream: "calendar", seq,
    ts: { wall: "2026-11-15T12:00:00.000Z", mono: String(seq + 1) },
    kind: seq === 0 ? "call" : "result", connector: "calendar", surface: "mcp", body: { inline: body } }));
  const index = await buildIndex(events, { policy, body: async event => {
    assert.ok(event.body && "inline" in event.body);
    return Buffer.from(event.body.inline);
  } });
  const ctx = replayCtx(index, policy);
  const call = (args: unknown) => toCall({ surface: "mcp", connector: "calendar", op: "tools/call:list_events", args, raw: { body: raw(args) } }, policy());
  assert.ok("answer" in await answerCall(call({}), ctx));
  const result = await answerCall(call({ filter: { title: "First" } }), ctx);
  assert.ok("answer" in result, `a declared simple nested filter must resolve: ${JSON.stringify(result)}`);
  assert.deepEqual(JSON.parse(JSON.parse(Buffer.from(result.answer.raw.body).toString()).result.content[0].text), [items[0]]);
});
