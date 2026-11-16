import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

// The shape of a real himalaya session against Gmail, with made-up mail: two messages sent to
// oneself in the same minute, listed in INBOX and in Sent Mail, then one read. The snapshot is
// capture events only, so it carries no account and no himalaya settings.
const me = "me@example.com";
const minute = "2026-11-16 20:33+00:00";
const envelope = (id, subject) => ({ id, flags: [], subject, from: { name: "Test Person", addr: me }, to: { name: null, addr: me }, date: minute, has_attachment: false });
const session = [
  [["himalaya", "envelope", "list", "-o", "json", "subject", "t57"], [envelope("68497", "[phoenix-test] t57 Lunch"), envelope("68496", "[phoenix-test] t57 Invoice")]],
  [["himalaya", "envelope", "list", "-f", "[Gmail]/Sent Mail", "-o", "json", "subject", "t57"], [envelope("427", "[phoenix-test] t57 Lunch"), envelope("425", "[phoenix-test] t57 Invoice")]],
  [["himalaya", "message", "read", "--preview", "-o", "json", "68496"], "From: Test Person <" + me + ">\nTo: " + me + "\nSubject: [phoenix-test] t57 Invoice\n\nInvoice due.\n"],
];

async function copyOf(t, observations = session) {
  const root = await mkdtemp(join(import.meta.dirname, ".gmail-session-"));
  const path = join(root, "snapshot.jsonl");
  const events = observations.flatMap(([argv, out, stdin], n) => [
    { kind: "call", op: "himalaya", body: { inline: JSON.stringify({ argv, cwd: "/", env: {}, terminals: { stdin: null, stdout: null, stderr: null } }) } },
    ...(stdin ? [{ kind: "call", op: "frame:out:0", body: { inline: stdin } }] : []),
    { kind: "result", op: "frame:back:1", body: { inline: JSON.stringify(out) + "\n" } },
    { kind: "result", op: "frame:back:3", body: { inline: JSON.stringify({ type: "exit", code: 0, signal: null }) } },
  ].map((e, seq) => ({ v: 1, capture: "gmail-session", stream: "cli-" + n, seq, connector: "email", surface: "cli", ts: { wall: "2026-11-16T20:33:4" + n + "Z" }, ...e })));
  await writeFile(path, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const child = spawn(process.execPath, ["plugins/email/src/serve.mjs"], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TZ: "America/Chicago", PHOENIX_HIMALAYA: "/opt/homebrew/bin/himalaya" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => { const exited = once(child, "close"); child.stdin.end(); await exited; await rm(root, { recursive: true, force: true }); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method, params) => {
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id: ++id, method, params }) + "\n");
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.status, "answer", JSON.stringify(reply));
    return reply.value;
  };
  await request("initialize", { snapshot: path });
  return async (argv, stdin = "") => {
    const args = { argv, cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
    const value = await request("call", { surface: "cli", layer: "agent", op: "himalaya", args, now: "2026-11-16T20:34:00Z",
      raw: { body: Buffer.from(JSON.stringify(args)).toString("base64"), stdin: Buffer.from(stdin).toString("base64") } });
    const frames = JSON.parse(Buffer.from(value.body, "base64").toString());
    const text = stream => frames.filter(f => f.stream === stream).map(f => Buffer.from(f.bytes, "base64").toString()).join("");
    assert.equal(JSON.parse(text(3)).code, 0, text(2));
    return text(1);
  };
}

const list = folder => ["himalaya", "envelope", "list", ...(folder ? ["-f", folder] : []), "-o", "json", "subject", "t57"];
const brief = stdout => JSON.parse(stdout).map(e => [e.id, e.subject.replace("[phoenix-test] t57 ", ""), e.flags, e.date]);

test("a Gmail session learned from himalaya keeps its order and dates", async t => {
  const copy = await copyOf(t);
  assert.deepEqual(brief(await copy(list())), [["68497", "Lunch", [], minute], ["68496", "Invoice", [], minute]]);
});

test("without himalaya settings, sending to oneself and deleting work like Gmail", async t => {
  const copy = await copyOf(t);
  const raw = ["From: Test Person <" + me + ">", "To: " + me, "Subject: [phoenix-test] t57 Paid", "Date: Mon, 16 Nov 2026 20:34:00 +0000", "Message-ID: <t57-paid@example.com>", "", "Paid.", ""].join("\r\n");
  assert.equal(await copy(["himalaya", "message", "send"], raw), "Message successfully sent!\n");
  assert.deepEqual(brief(await copy(list())).map(([id, subject, flags]) => [id, subject, flags]), [["68498", "Paid", []], ["68497", "Lunch", []], ["68496", "Invoice", []]]);
  assert.deepEqual(brief(await copy(list("[Gmail]/Sent Mail"))).map(([, subject, flags]) => [subject, flags]), [["Paid", []], ["Lunch", []], ["Invoice", []]]);
  await copy(["himalaya", "message", "delete", "68496"]);
  assert.deepEqual(brief(await copy(list("[Gmail]/Sent Mail"))).map(([, subject]) => subject), ["Paid", "Lunch"]);
  assert.deepEqual(brief(await copy(list("[Gmail]/Trash"))).map(([, subject]) => subject), ["Invoice"]);
});

test("S14: a listing through the new sent alias seeds the same mailbox", async t => {
  const source = await copyOf(t);
  const argv = list("sent");
  const envelopes = JSON.parse(await source(argv));
  assert.equal(envelopes.length, 2);
  const copy = await copyOf(t, [[argv, envelopes]]);
  assert.deepEqual(JSON.parse(await copy(argv)).map(e => e.id), envelopes.map(e => e.id));
});

test("S15: a fuller later listing refines same-minute ordering", async t => {
  const source = await copyOf(t);
  const narrow = ["himalaya", "envelope", "list", "-o", "json", "subject", "Lunch"];
  const one = JSON.parse(await source(narrow));
  const both = JSON.parse(await source(list()));
  assert.equal(one.length, 1);
  assert.equal(both.length, 2);
  const copy = await copyOf(t, [[narrow, one], [list(), both]]);
  assert.deepEqual(JSON.parse(await copy(list())).map(e => e.id), both.map(e => e.id));
});

test("S16: the search word order is not an order-by clause", async t => {
  const all = ["himalaya", "envelope", "list", "-o", "json"];
  const source = await copyOf(t, [[all, [
    envelope("68497", "[phoenix-test] order new"), envelope("68496", "[phoenix-test] order old"),
  ]]]);
  const query = [...all, "subject", "order"];
  const envelopes = JSON.parse(await source(query));
  assert.equal(envelopes.length, 2);
  const copy = await copyOf(t, [[query, envelopes]]);
  assert.deepEqual(JSON.parse(await copy(query)).map(e => e.id), envelopes.map(e => e.id));
});

test("S17: an order-by clause after a condition-word search value remains a sort", async t => {
  const all = ["himalaya", "envelope", "list", "-o", "json"];
  const source = await copyOf(t, [[all, [
    envelope("68497", "[phoenix-test] date new"), envelope("68496", "[phoenix-test] date old"),
  ]]]);
  const query = [...all, "subject", "date", "order", "by", "date", "asc"];
  const envelopes = JSON.parse(await source(query));
  assert.equal(envelopes.length, 2);
  const copy = await copyOf(t, [[query, envelopes]]);
  assert.deepEqual(JSON.parse(await copy(query)).map(e => e.id), envelopes.map(e => e.id));
});


test("a snapshot cut just after himalaya writes holds them", async t => {
  const raw = ["From: Test Person <" + me + ">", "To: " + me, "Subject: [phoenix-test] t57 Paid", "Date: Mon, 16 Nov 2026 20:34:00 +0000", "Message-ID: <t57-paid@example.com>", "Content-Type: text/plain; charset=utf-8", "", "Paid.", ""].join("\r\n");
  const copy = await copyOf(t, [
    session[0],
    [["himalaya", "message", "send"], "Message successfully sent!", raw],
    [list("[Gmail]/Sent Mail"), [{ ...envelope("429", "[phoenix-test] t57 Paid"), date: "2026-11-16 20:34+00:00" }]],
    [["himalaya", "message", "move", "[Gmail]/All Mail", "68497"], "moved"],
    [["himalaya", "message", "delete", "68496"], "removed"],
  ]);
  await assert.rejects(() => copy(list()), /unsupported/);
  await assert.rejects(() => copy(list("[Gmail]/Sent Mail")), /unsupported/);
  assert.deepEqual(brief(await copy(list("[Gmail]/Trash"))).map(([, subject]) => subject), ["Invoice"]);
  await assert.rejects(() => copy(["himalaya", "message", "read", "--preview", "-f", "[Gmail]/Sent Mail", "429"]), /unsupported/);
});
