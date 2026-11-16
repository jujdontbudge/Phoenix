import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

// When the engine runs a recorded call against the copy, it sends the recorded answer with it. What the
// copy made then takes the recorded ids, so later calls by those ids reach the copy. Made-up mail only.
const me = "me@example.com", now = "2026-11-16T20:40:00Z";
const b64 = v => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");

async function serve(t, name, snapshot) {
  const root = await mkdtemp(join(import.meta.dirname, ".recorded-ids-"));
  await writeFile(join(root, name), snapshot);
  const child = spawn(process.execPath, ["plugins/email/src/serve.mjs"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC", PHOENIX_HIMALAYA: "/opt/homebrew/bin/himalaya" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { const exited = once(child, "close"); child.stdin.end(); await exited; await rm(root, { recursive: true, force: true }); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method, params) => {
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id: ++id, method, params }) + "\n");
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.status, "answer", JSON.stringify(reply));
    return reply.value;
  };
  await request("initialize", { snapshot: join(root, name) });
  return request;
}

test("connector: a mirrored send, draft and label keep their recorded ids", async t => {
  const request = await serve(t, "snapshot.json", JSON.stringify({ account: { email: me }, labels: [{ labelId: "INBOX", name: "INBOX", labelType: "SYSTEM" }] }));
  const tool = async (name, args, recorded) => {
    const params = { surface: "mcp", layer: "agent", op: "tools/call:" + name, args, now, raw: { body: b64({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }) } };
    if (recorded) params.recorded = { body: b64({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: JSON.stringify(recorded) }] } }) };
    const result = JSON.parse(Buffer.from((await request("call", params)).body, "base64").toString()).result;
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await tool("send_message", { to: ["ana@example.com"], subject: "[phoenix-test] sent", body: "Sent." }, { id: "1a1e6170aa000001", threadId: "1a1e6170aa000001" })).id, "1a1e6170aa000001");
  assert.equal((await tool("get_message", { messageId: "1a1e6170aa000001" })).id, "1a1e6170aa000001");
  assert.equal((await tool("create_draft", { to: ["ana@example.com"], subject: "[phoenix-test] draft", body: "Draft." }, { id: "r-5550001112223334445", messageId: "1a1e6171bb000002", threadId: "1a1e6171bb000002" })).id, "r-5550001112223334445");
  assert.equal((await tool("get_draft", { draftId: "r-5550001112223334445" })).messageId, "1a1e6171bb000002");
  assert.equal((await tool("create_label", { displayName: "[phoenix-test] label" }, { labelId: "Label_41", name: "[phoenix-test] label" })).labelId, "Label_41");
  assert.equal((await tool("update_label", { labelId: "Label_41", displayName: "[phoenix-test] renamed" })).name, "[phoenix-test] renamed");
  assert.notEqual((await tool("send_message", { to: ["ana@example.com"], subject: "[phoenix-test] unrecorded", body: "New." })).id, "1a1e6170aa000001");
});

test("himalaya: a mirrored envelope list gives the copy's messages the recorded ids", async t => {
  const env = (id, subject, to = me) => ({ id, flags: [], subject, from: { name: "Test Person", addr: me }, to: { name: null, addr: to }, date: "2026-11-16 20:33+00:00", has_attachment: false });
  const sent = ["himalaya", "envelope", "list", "-f", "[Gmail]/Sent Mail", "-o", "json", "subject", "t57"];
  const events = [
    { kind: "call", op: "himalaya", body: { inline: JSON.stringify({ argv: sent, cwd: "/", env: {}, terminals: { stdin: null, stdout: null, stderr: null } }) } },
    { kind: "result", op: "frame:back:1", body: { inline: JSON.stringify([env("427", "[phoenix-test] t57 Lunch")]) + "\n" } },
  ].map((e, seq) => ({ v: 1, capture: "test", stream: "cli-0", seq, connector: "email", surface: "cli", ts: { wall: "2026-11-16T20:33:40Z" }, ...e }));
  const request = await serve(t, "snapshot.jsonl", events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const cli = async (argv, stdin = "", recorded) => {
    const args = { argv, cwd: "/", env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
    const params = { surface: "cli", layer: "agent", op: "himalaya", args, now, raw: { body: b64(args), stdin: b64(stdin) } };
    if (recorded !== undefined) params.recorded = { body: b64([{ dir: "back", stream: 1, bytes: b64(recorded), last: true }]) };
    const frames = JSON.parse(Buffer.from((await request("call", params)).body, "base64").toString());
    return frames.filter(f => f.stream === 1).map(f => Buffer.from(f.bytes, "base64").toString()).join("");
  };
  const raw = ["From: Test Person <" + me + ">", "To: ana@example.com", "Subject: [phoenix-test] t57 Paid", "Date: Mon, 16 Nov 2026 20:33:50 +0000", "Message-ID: <t57-paid@example.com>", "Content-Type: text/plain; charset=utf-8", "", "Paid.", ""].join("\r\n");
  await cli(["himalaya", "message", "send"], raw, "Message successfully sent!\n");
  const ids = stdout => JSON.parse(stdout).map(e => e.id);
  assert.deepEqual(ids(await cli(sent, "", JSON.stringify([env("429", "[phoenix-test] t57 Paid", "ana@example.com"), env("427", "[phoenix-test] t57 Lunch")]))), ["429", "427"]);
  assert.deepEqual(ids(await cli(sent)), ["429", "427"]);
  assert.match(await cli(["himalaya", "message", "read", "--preview", "-f", "[Gmail]/Sent Mail", "429"]), /Subject: \[phoenix-test\] t57 Paid/);
});

async function mcp(request, name, args, recorded) {
  const rpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } };
  const params = { surface: "mcp", layer: "agent", op: "tools/call:" + name, args, now, raw: { body: b64(rpc) } };
  if (recorded) params.recorded = { body: b64({ jsonrpc: "2.0", id: 7, result: { structuredContent: recorded } }) };
  const result = JSON.parse(Buffer.from((await request("call", params)).body, "base64").toString()).result;
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}

async function listing(request, argv, recorded) {
  const args = { argv, cwd: "/synthetic", env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
  const params = { surface: "cli", layer: "agent", op: "himalaya", args, now, raw: { body: b64(args), stdin: "" } };
  if (recorded) params.recorded = { body: b64([{ dir: "back", stream: 1, bytes: b64(recorded), last: true }]) };
  const frames = JSON.parse(Buffer.from((await request("call", params)).body, "base64").toString());
  const text = stream => frames.filter(f => f.stream === stream).map(f => Buffer.from(f.bytes, "base64").toString()).join("");
  assert.equal(JSON.parse(text(3)).code, 0, text(2));
  return JSON.parse(text(1));
}

test("S18: adopting a recorded draft id must not overwrite another draft", async t => {
  const request = await serve(t, "snapshot.json", JSON.stringify({ account: { email: me }, labels: [] }));
  const old = await mcp(request, "create_draft", { subject: "[phoenix-test] original draft", body: "Original" });
  await mcp(request, "create_draft", { subject: "[phoenix-test] new draft", body: "New" }, {
    id: old.id, messageId: "1a1e6171bb000002", threadId: "1a1e6171bb000002",
  });
  assert.equal((await mcp(request, "get_draft", { draftId: old.id })).subject, "[phoenix-test] original draft");
});

test("S19: adopting a new forward thread preserves the original complete thread", async t => {
  const request = await serve(t, "snapshot.json", JSON.stringify({ account: { email: me }, labels: [] }));
  const old = await mcp(request, "send_message", { to: ["ana@example.com"], subject: "[phoenix-test] original", body: "Original" });
  assert.equal((await mcp(request, "get_thread", { threadId: old.threadId })).messageCount, 1);
  const forwarded = await mcp(request, "forward", { messageId: old.id, to: ["ben@example.com"], forwardText: "Forward" }, {
    id: "1a1e6171bb000002", threadId: "1a1e6171bb000002",
  });
  assert.equal((await mcp(request, "get_thread", { threadId: old.threadId })).messageCount, 1);
  assert.equal((await mcp(request, "get_thread", { threadId: forwarded.threadId })).messageCount, 1);
});

test("S20: matching subjects alone must not bind a different sender's recorded UID", async t => {
  const snapshot = (sender, uid) => JSON.stringify({ account: { email: me }, messages: [{
    id: "1a1e6171bb000" + String(uid).padStart(3, "0"), threadId: "1a1e6171bb000" + String(uid).padStart(3, "0"), labelIds: ["INBOX"],
    internalDate: String(Date.parse(now)), sender, subject: "[phoenix-test] repeated subject", plaintextBody: "Synthetic body from " + sender,
    uids: { INBOX: uid },
  }] });
  const argv = ["himalaya", "envelope", "list", "-o", "json"];
  const source = await serve(t, "source.json", snapshot("ben@example.com", 999));
  const request = await serve(t, "snapshot.json", snapshot("ana@example.com", 1));
  const real = await listing(source, argv);
  assert.equal(real[0].from.addr, "ben@example.com");
  assert.equal((await listing(request, argv))[0].from.addr, "ana@example.com");
  await listing(request, argv, real);
  assert.equal((await listing(request, argv))[0].id, "1");
});

test("S21: an adopted UID stays reserved when its message is temporarily hidden", async t => {
  const request = await serve(t, "snapshot.json", JSON.stringify({ account: { email: me }, labels: [] }));
  const old = await mcp(request, "send_message", { to: ["ana@example.com"], subject: "[phoenix-test] old", body: "Old" });
  const argv = ["himalaya", "envelope", "list", "-f", "[Gmail]/Sent Mail", "-o", "json"];
  const first = await listing(request, argv);
  await listing(request, argv, first.map(e => ({ ...e, id: "2" })));
  await mcp(request, "trash_message", { messageId: old.id });
  await mcp(request, "send_message", { to: ["ana@example.com"], subject: "[phoenix-test] new", body: "New" });
  assert.notEqual((await listing(request, argv))[0].id, "2");
});
