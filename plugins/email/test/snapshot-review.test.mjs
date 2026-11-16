import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const time = "2026-11-16T12:00:00Z";
const argv = ["himalaya", "envelope", "list", "-o", "json"];

async function serve(t, snapshot) {
  const root = await mkdtemp(join(import.meta.dirname, ".snapshot-review-"));
  const path = join(root, "snapshot.json");
  await writeFile(path, typeof snapshot === "string" ? snapshot : JSON.stringify({ account: { email: "test@example.com" }, ...snapshot }));
  const child = spawn(process.execPath, ["plugins/email/src/serve.mjs"], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PHOENIX_HIMALAYA: "/opt/homebrew/bin/himalaya" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    const exited = once(child, "close");
    child.stdin.end();
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method, params) => {
    child.stdin.write(JSON.stringify({ phoenix_plugin: 1, id: ++id, method, params }) + "\n");
    const reply = JSON.parse((await lines.next()).value);
    assert.equal(reply.status, "answer", JSON.stringify(reply));
    return reply.value;
  };
  await request("initialize", { snapshot: path });
  return async argv => {
    const args = { argv, cwd: root, env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
    const value = await request("call", { surface: "cli", layer: "agent", op: "himalaya", args, now: time,
      raw: { body: Buffer.from(JSON.stringify(args)).toString("base64"), stdin: "" } });
    const frames = JSON.parse(Buffer.from(value.body, "base64").toString());
    const text = stream => frames.filter(f => f.stream === stream).map(f => Buffer.from(f.bytes, "base64").toString()).join("");
    assert.equal(JSON.parse(text(3)).code, 0, text(2));
    return text(1);
  };
}

async function listedMail(t, recipient = "Test Recipient") {
  const raw = [
    "From: Sender Name <sender@example.com>", `To: ${JSON.stringify(recipient)} <test@example.com>`,
    "Subject: [phoenix-test] named recipient", "Date: Mon, 16 Nov 2026 12:00:00 +0000",
    "Message-ID: <phoenix-test@example.com>", "Content-Type: text/plain; charset=UTF-8", "", "Synthetic body",
  ].join("\r\n");
  const source = await serve(t, { messages: [{
    id: "19a8c12345600001", threadId: "19a8c12345600001", internalDate: String(Date.parse(time)),
    labelIds: ["INBOX"], uids: { INBOX: 4521 }, raw: Buffer.from(raw).toString("base64url"),
  }] });
  const stdout = await source(argv);
  assert.equal(JSON.parse(stdout)[0].to.name, recipient);
  return stdout;
}

test("S12: a recorded CLI meta/open invocation seeds its stdout", async t => {
  const stdout = await listedMail(t);
  const events = [
    { kind: "meta", op: "open", value: { surface: "cli", connector: "email", meta: {
      argv, cwd: "/synthetic", env: {}, terminals: { stdin: null, stdout: null, stderr: null },
    } } },
    { kind: "result", op: "frame:back:1", value: stdout },
    { kind: "result", op: "frame:back:3", value: { type: "exit", code: 0, signal: null } },
  ].map(({ value, ...event }, seq) => ({
    v: 1, capture: "review", stream: "cli.email", seq, connector: "email", surface: "cli",
    ts: { wall: time, mono: String(seq) }, ...event,
    body: { inline: typeof value === "string" ? value : JSON.stringify(value) },
  }));
  const copy = await serve(t, events.map(event => JSON.stringify(event) + "\n").join(""));
  assert.deepEqual(JSON.parse(await copy(argv)).map(e => e.id), ["4521"]);
});

test("S13: learning an envelope preserves its recipient display name", async t => {
  const stdout = await listedMail(t);
  const copy = await serve(t, { himalaya_output: [{ argv, stdout, at: time }] });
  const learned = JSON.parse(await copy(argv));
  assert.deepEqual(learned[0].to, JSON.parse(stdout)[0].to);
});

test("S13b: learning a comma-containing recipient name preserves the full name", async t => {
  const stdout = await listedMail(t, "Recipient, Test");
  const copy = await serve(t, { himalaya_output: [{ argv, stdout, at: time }] });
  const learned = JSON.parse(await copy(argv));
  assert.deepEqual(learned[0].to, JSON.parse(stdout)[0].to);
});
