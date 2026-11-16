import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const me = "me@example.com", sent = "[Gmail]/Sent Mail", now = "2026-11-16T20:34:00Z";
const b64 = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
const list = folder => ["himalaya", "envelope", "list", ...(folder ? ["-f", folder] : []), "-o", "json"];
const envelope = (id, subject) => ({ id, flags: [], subject, from: { name: "Test Person", addr: me }, to: { name: null, addr: "ana@example.com" }, date: "2026-11-16 20:33+00:00", has_attachment: false });
const raw = (name, body, minute = "34") => ["From: Test Person <" + me + ">", "To: ana@example.com", "Subject: [phoenix-test] t57 " + name, "Date: Mon, 16 Nov 2026 20:" + minute + ":00 +0000", "Message-ID: <write-review-" + name + "@example.com>", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");

function cliEvents(runs) {
  return runs.flatMap((run, n) => {
    const frames = [{ kind: "call", op: "himalaya", body: { inline: JSON.stringify({ argv: run.argv, cwd: "/synthetic", env: {}, terminals: { stdin: null, stdout: null, stderr: null } }) } }];
    if (run.stdin !== undefined) frames.push({ kind: "call", op: "frame:out:0", body: { inline: run.stdin } });
    if (run.stdout !== undefined) frames.push({ kind: "result", op: "frame:back:1", body: { inline: typeof run.stdout === "string" ? run.stdout : JSON.stringify(run.stdout) } });
    if (run.code !== null) frames.push({ kind: "result", op: "frame:back:3", body: { inline: JSON.stringify({ type: "exit", code: run.code ?? 0, signal: null }) } });
    return frames.map((frame, seq) => ({ v: 1, capture: "synthetic-write-review", connector: "email", surface: "cli", stream: "cli-" + n, seq, ts: { wall: run.at ?? "2026-11-16T20:33:" + (40 + n) + "Z" }, ...frame }));
  });
}

function mcpEvents(name, args, value, at) {
  return [
    { kind: "call", body: { inline: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }) } },
    { kind: "result", body: { inline: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { structuredContent: value } }) } },
  ].map((event, seq) => ({ v: 1, capture: "synthetic-write-review", connector: "email", surface: "mcp", stream: "mcp-" + name, seq, op: "tools/call:" + name, ts: { wall: at }, ...event }));
}

async function copyOf(t, events) {
  const root = await mkdtemp(join(import.meta.dirname, ".write-review-"));
  const snapshot = join(root, "snapshot.jsonl");
  await writeFile(snapshot, Array.isArray(events) ? events.map(event => JSON.stringify(event)).join("\n") + "\n" : JSON.stringify(events));
  const child = spawn(process.execPath, ["plugins/email/src/serve.mjs"], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "UTC", PHOENIX_HIMALAYA: "/opt/homebrew/bin/himalaya" }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { const exited = once(child, "close"); child.stdin.end(); await exited; await rm(root, { recursive: true, force: true }); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const exchange = async (method, params) => {
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id: ++id, method, params }) + "\n");
    return JSON.parse((await lines.next()).value);
  };
  const request = async (method, params) => {
    const reply = await exchange(method, params);
    assert.equal(reply.status, "answer", JSON.stringify(reply));
    return reply.value;
  };
  await request("initialize", { snapshot });
  return {
    response: async argv => {
      const args = { argv, cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
      return exchange("call", { surface: "cli", layer: "agent", op: "himalaya", args, now, raw: { body: b64(args), stdin: b64("") } });
    },
    cli: async (argv, stdin = "") => {
      const args = { argv, cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
      const value = await request("call", { surface: "cli", layer: "agent", op: "himalaya", args, now, raw: { body: b64(args), stdin: b64(stdin) } });
      const frames = JSON.parse(Buffer.from(value.body, "base64").toString());
      const text = stream => frames.filter(frame => frame.stream === stream).map(frame => Buffer.from(frame.bytes, "base64").toString()).join("");
      assert.equal(JSON.parse(text(3)).code, 0, text(2));
      return text(1);
    },
    tool: async (name, args) => {
      const rpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } };
      const value = await request("call", { surface: "mcp", layer: "agent", op: "tools/call:" + name, args, now, raw: { body: b64(rpc) } });
      const result = JSON.parse(Buffer.from(value.body, "base64").toString()).result;
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    },
  };
}

test("S22: a non-preview JSON read still teaches the captured body", async t => {
  const copy = await copyOf(t, cliEvents([
    { argv: list(), stdout: [envelope("10", "[phoenix-test] t57 Invoice")] },
    { argv: ["himalaya", "message", "read", "-o", "json", "10"], stdout: JSON.stringify("From: Test Person <" + me + ">\nTo: ana@example.com\nSubject: [phoenix-test] t57 Invoice\n\nInvoice due.\n") },
  ]));
  assert.match(await copy.cli(["himalaya", "message", "read", "--preview", "10"]), /Invoice due\./);
});

test("S23: real list UIDs must not identify another message's temporary UID", async t => {
  const base = envelope("10", "[phoenix-test] t57 Base");
  const source = await copyOf(t, cliEvents([{ argv: list(sent), stdout: [base, envelope("11", "[phoenix-test] unrelated")] }]));
  const a = raw("A", "Synthetic body A."), b = raw("B", "Synthetic body B.", "35");
  await source.cli(["himalaya", "message", "send"], a);
  await source.cli(["himalaya", "message", "send"], b);
  const ordered = [...list(sent), "subject", "t57", "order", "by", "date", "asc"];
  const real = JSON.parse(await source.cli(ordered));
  const aUid = real.find(message => message.subject.endsWith(" A")).id;
  assert.equal(aUid, "13");
  const copy = await copyOf(t, cliEvents([
    { argv: [...list(sent), "subject", "t57"], stdout: [base] },
    { argv: ["himalaya", "message", "send"], stdin: a, stdout: "Message successfully sent!\n" },
    { argv: ["himalaya", "message", "send"], stdin: b, stdout: "Message successfully sent!\n" },
    { argv: ordered, stdout: real },
  ]));
  await assert.rejects(() => copy.cli(["himalaya", "message", "read", "--preview", "-f", sent, aUid]), /unsupported/);
});

test("S24: a captured send without an exit is not a successful past write", async t => {
  const copy = await copyOf(t, cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Pending", "Pending body."), code: null }]));
  assert.deepEqual(JSON.parse(await copy.cli(list(sent))), []);
});

test("S25: a later MCP observation must not duplicate an earlier CLI send", async t => {
  const id = "1a1e6168d0000001";
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Once", plaintextBody: "Send once.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Once", "Send once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_thread", { threadId: id, messageFormat: "FULL_CONTENT" }, { id, messageCount: 1, messages: [message] }, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S27: a later MCP unread change must win over an earlier CLI seen change", async t => {
  const id = "1a1e6168d0000001";
  const message = { id, threadId: id, labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.parse("2026-11-16T20:33:00Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Invoice", plaintextBody: "Invoice due.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const initial = [
    ...mcpEvents("get_message", { messageId: id }, message, "2026-11-16T20:33:39Z"),
    ...cliEvents([{ argv: list(), stdout: [envelope("10", message.subject)] }]),
  ];
  const source = await copyOf(t, initial);
  await source.cli(["himalaya", "flag", "add", "10", "seen"]);
  assert.ok(JSON.parse(await source.cli(list()))[0].flags.includes("Seen"));
  await source.tool("label_message", { messageId: id, labelIds: ["UNREAD"] });
  assert.ok(!JSON.parse(await source.cli(list()))[0].flags.includes("Seen"));
  const copy = await copyOf(t, [
    ...mcpEvents("get_message", { messageId: id }, message, "2026-11-16T20:33:39Z"),
    ...cliEvents([{ argv: list(), stdout: [envelope("10", message.subject)] }, { argv: ["himalaya", "flag", "add", "10", "seen"], stdout: "Flags successfully added!\n" }]),
    ...mcpEvents("label_message", { messageId: id, labelIds: ["UNREAD"] }, {}, "2026-11-16T20:33:50Z"),
  ]);
  assert.ok(!JSON.parse(await copy.cli(list()))[0].flags.includes("Seen"));
});

test("S26: historical envelope matching must distinguish same-minute recipients", async t => {
  const source = await copyOf(t, cliEvents([{ argv: list(sent), stdout: [envelope("100", "[phoenix-test] unrelated")] }]));
  const a = raw("A", "Synthetic body A.").replace("Subject: [phoenix-test] t57 A", "Subject: [phoenix-test] t57 Same");
  const b = raw("B", "Synthetic body B.").replace("Subject: [phoenix-test] t57 B", "Subject: [phoenix-test] t57 Same").replace("To: ana@example.com", "To: ben@example.com").replace("20:34:00", "20:34:30");
  await source.cli(["himalaya", "message", "send"], a);
  await source.cli(["himalaya", "message", "send"], b);
  const argv = [...list(sent), "subject", "t57"];
  const real = JSON.parse(await source.cli(argv));
  assert.equal(real[0].to.addr, "ben@example.com");
  assert.equal(real[0].id, "104");
  const copy = await copyOf(t, cliEvents([
    { argv: ["himalaya", "message", "send"], stdin: a, stdout: "Message successfully sent!\n" },
    { argv: ["himalaya", "message", "send"], stdin: b, stdout: "Message successfully sent!\n" },
    { argv, stdout: real },
  ]));
  await assert.rejects(() => copy.cli(["himalaya", "message", "read", "--preview", "-f", sent, real[0].id]), /unsupported/);
});

test("S28: writes observed after an explicit snapshot cut must not be applied", async t => {
  const copy = await copyOf(t, {
    account: { email: me }, cut_at: "2026-11-16T20:33:40Z",
    himalaya_output: [{ argv: ["himalaya", "message", "send"], stdin: raw("Future", "Future body."), stdout: "Message successfully sent!\n", code: 0, at: "2026-11-16T20:33:50Z" }],
  });
  assert.deepEqual(JSON.parse(await copy.cli(list(sent))), []);
});

test("S29: claiming a provisional send must reject a contradictory known body", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:50Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:50Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Claim", plaintextBody: "Different observed body.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Claim", "Original sent body."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:55Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S30: a captured JSON read of the same Message-ID must not duplicate a replayed send", async t => {
  const source = await copyOf(t, { account: { email: me } });
  const message = raw("Direct", "Read the same mail.");
  await source.cli(["himalaya", "message", "send"], message);
  const [listed] = JSON.parse(await source.cli(list(sent)));
  const read = ["himalaya", "message", "read", "--preview", "-f", sent, "-o", "json", ...["From", "To", "Subject", "Date", "Message-ID"].flatMap(name => ["-H", name]), listed.id];
  const output = await source.cli(read);
  assert.match(JSON.parse(output), /message-id:\s*<write-review-Direct@example\.com>/i);
  const copy = await copyOf(t, cliEvents([
    { argv: ["himalaya", "message", "send"], stdin: message, stdout: "Message successfully sent!\n" },
    { argv: read, stdout: output },
  ]));
  assert.equal(JSON.parse(await copy.cli(list(sent))).length, 1);
});

test("S25b: a metadata observation before full content must still claim a replayed send", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const metadata = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const message = { ...metadata, subject: "[phoenix-test] t57 Once", plaintextBody: "Send once." };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Once", "Send once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "METADATA_ONLY" }, metadata, "2026-11-16T20:33:45Z"),
    ...mcpEvents("get_thread", { threadId: id, messageFormat: "FULL_CONTENT" }, { id, messageCount: 1, messages: [message] }, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S31: ambiguous envelope matches must not answer with extra mail", async t => {
  const source = await copyOf(t, cliEvents([{ argv: list(sent), stdout: [envelope("100", "[phoenix-test] unrelated")] }]));
  const a = raw("A", "Synthetic body A.").replace("Subject: [phoenix-test] t57 A", "Subject: [phoenix-test] t57 Same");
  const b = raw("B", "Synthetic body B.").replace("Subject: [phoenix-test] t57 B", "Subject: [phoenix-test] t57 Same").replace("20:34:00", "20:34:30");
  await source.cli(["himalaya", "message", "send"], a);
  await source.cli(["himalaya", "message", "send"], b);
  const argv = [...list(sent), "subject", "t57"];
  const real = JSON.parse(await source.cli(argv));
  assert.equal(real.length, 2);
  const copy = await copyOf(t, cliEvents([
    { argv: ["himalaya", "message", "send"], stdin: a, stdout: "Message successfully sent!\n" },
    { argv: ["himalaya", "message", "send"], stdin: b, stdout: "Message successfully sent!\n" },
    { argv, stdout: real },
  ]));
  const response = await copy.response(argv);
  if (response.status === "unsupported") return;
  assert.equal(response.status, "answer", JSON.stringify(response));
  const frames = JSON.parse(Buffer.from(response.value.body, "base64").toString());
  assert.equal(JSON.parse(Buffer.from(frames.find(frame => frame.stream === 3).bytes, "base64").toString()).code, 0);
  const stdout = frames.filter(frame => frame.stream === 1).map(frame => Buffer.from(frame.bytes, "base64").toString()).join("");
  assert.equal(JSON.parse(stdout).length, real.length);
});

test("S29b: a contradictory known HTML body must not claim another send", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:50Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:50Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Html", htmlBody: "<p>Different HTML.</p>", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const html = raw("Html", "<p>Original HTML.</p>").replace("Content-Type: text/plain; charset=utf-8", "Content-Type: text/html; charset=utf-8");
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: html, stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:55Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S32: claiming a metadata placeholder preserves a known incomplete thread count", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const replyId = ((BigInt(Date.parse("2026-11-16T20:33:43Z")) << 20n) | 1n).toString(16);
  const metadata = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const message = { ...metadata, subject: "[phoenix-test] t57 Count", plaintextBody: "Count once." };
  const reply = { id: replyId, threadId: id, labelIds: ["INBOX"], internalDate: String(Date.parse("2026-11-16T20:33:43Z")), sender: "ana@example.com", toRecipients: [me], subject: "Re: [phoenix-test] t57 Count", snippet: "Reply" };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Count", "Count once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("search_threads", { query: "t57", view: "THREAD_VIEW_SUMMARY" }, { resultCountEstimate: "1", threads: [{ id, messageCount: 6, messages: [reply] }] }, "2026-11-16T20:33:45Z"),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "METADATA_ONLY" }, metadata, "2026-11-16T20:33:46Z").map(event => ({ ...event, stream: "mcp-metadata" })),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:50Z").map(event => ({ ...event, stream: "mcp-full" })),
  ]);
  await assert.rejects(() => copy.tool("get_thread", { threadId: id, messageFormat: "METADATA_ONLY" }), /only part of thread/);
});

test("S29c: contradictory known bodies must not merge across plain and HTML formats", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:50Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:50Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Mixed", htmlBody: "<p>Different HTML body.</p>", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Mixed", "Original plaintext body."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:55Z"),
  ]);
  await assert.rejects(() => copy.cli(list(sent)), /unsupported/);
});

test("S32b: an authoritative thread count survives a claim without a metadata placeholder", async t => {
  const id = ((BigInt(Date.parse("2026-11-16T20:33:40Z")) << 20n) | 1n).toString(16);
  const replyId = ((BigInt(Date.parse("2026-11-16T20:33:43Z")) << 20n) | 1n).toString(16);
  const message = { id, threadId: id, labelIds: ["SENT"], internalDate: String(Date.parse("2026-11-16T20:33:40Z")), sender: me, toRecipients: ["ana@example.com"], subject: "[phoenix-test] t57 Count", plaintextBody: "Count once.", viewUrl: "https://mail.google.com/mail/?authuser=" + me };
  const reply = { id: replyId, threadId: id, labelIds: ["INBOX"], internalDate: String(Date.parse("2026-11-16T20:33:43Z")), sender: "ana@example.com", toRecipients: [me], subject: "Re: [phoenix-test] t57 Count", snippet: "Reply" };
  const copy = await copyOf(t, [
    ...cliEvents([{ argv: ["himalaya", "message", "send"], stdin: raw("Count", "Count once."), stdout: "Message successfully sent!\n" }]),
    ...mcpEvents("search_threads", { query: "t57", view: "THREAD_VIEW_SUMMARY" }, { resultCountEstimate: "1", threads: [{ id, messageCount: 6, messages: [reply] }] }, "2026-11-16T20:33:45Z"),
    ...mcpEvents("get_message", { messageId: id, messageFormat: "FULL_CONTENT" }, message, "2026-11-16T20:33:50Z"),
  ]);
  await assert.rejects(() => copy.tool("get_thread", { threadId: id, messageFormat: "METADATA_ONLY" }), /only part of thread/);
});
