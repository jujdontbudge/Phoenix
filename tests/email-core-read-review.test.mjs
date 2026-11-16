import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { startEngine } from "../packages/engine/src/index.ts";
import { readPlugin } from "../packages/plugin-host/src/index.ts";
import { cliTap, frame } from "../packages/taps/src/index.ts";

test("S11: a read-only CLI call does not disable recorded attachment fallback", async t => {
  const root = await mkdtemp(join(import.meta.dirname, ".email-S11-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = await readPlugin(resolve("plugins/email/phoenix-plugin.json"));
  const snapshot = join(root, "snapshot.json");
  await writeFile(snapshot, JSON.stringify({ account: { email: "test@example.com" }, labels: [] }));
  const invocation = {
    argv: ["himalaya", "folder", "list"], cwd: root, env: {},
    terminals: { stdin: null, stdout: null, stderr: null },
  };
  const rpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: {
    name: "download_gmail_attachment", arguments: { messageId: "19a8c12345600001", attachmentId: "fixture" },
  } };
  const response = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "[phoenix-test] recorded attachment" }] } };
  const time = "2026-11-16T12:00:00Z";
  const events = [
    { stream: "cli.email", seq: 0, kind: "call", surface: "cli", op: "himalaya", value: invocation },
    { stream: "cli.email", seq: 1, kind: "call", surface: "cli", op: "frame:out:0", value: "" },
    { stream: "cli.email", seq: 2, kind: "result", surface: "cli", op: "frame:back:3", value: { type: "exit", code: 0, signal: null } },
    { stream: "mcp.email", seq: 0, kind: "call", surface: "mcp", op: "tools/call:download_gmail_attachment", value: rpc },
    { stream: "mcp.email", seq: 1, kind: "result", surface: "mcp", op: "tools/call:download_gmail_attachment", value: response },
  ].map(({ value, ...event }, i) => ({
    v: 1, capture: "review", connector: "email", layer: "agent", ...event,
    id: `${event.stream}:${event.seq}`, ts: { wall: time, mono: String(i) },
    body: { inline: typeof value === "string" ? value : JSON.stringify(value) },
  }));
  const sandbox = { async start(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.workdir, env: spec.env, stdio: "pipe" });
    const channel = new PassThrough({ objectMode: true });
    const exited = once(child, "close").then(([code, signal]) => ({ code, signal }));
    return { channel, process: {
      id: "local-protocol-proof", stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      exited, interrupted: new Promise(() => {}), clock: { clock: "real", binaries: [] },
      async exec() { throw new Error("Not used by stdio protocol proof"); },
      async stop() { child.kill("SIGTERM"); await exited; channel.end(); },
    } };
  } };
  const engine = await startEngine({
    evidence: { events, body: async event => Buffer.from(event.body.inline) },
    connectors: { email: { read_only: plugin.descriptor.read_only.map(op => ({ op, source: "plugin" })) } },
    routes: {}, hmacKey: Buffer.alloc(32, 1),
    emulators: [{ plugin, options: {
      context: { snapshot }, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PHOENIX_HIMALAYA: "/opt/homebrew/bin/himalaya" },
      replay: { sandbox, spec: { image: "local-proof", mounts: [], clockFile: join(root, "clock"), workdir: plugin.directory } },
    } }],
    sample: { root: join(root, "sample"), metadata: {
      capture: "sample", harness: { name: "review", tree: "none" }, recipe: { name: "review", version: "1" },
      routes: [], started_at: time, boot_id: "review",
    } },
  });
  t.after(() => engine.close());
  const exit = await cliTap({
    backend: engine.backend, connector: "email", argv: invocation.argv, cwd: root, env: {}, allowEnv: [],
    io: { stdin: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() },
  });
  assert.equal(exit.code, 0);
  const link = engine.backend.open({ surface: "mcp", connector: "email", meta: { transport: "stdio" } });
  t.after(() => link.abort("cleanup"));
  const received = (async () => {
    for await (const f of link.frames()) return JSON.parse(Buffer.from(f.bytes).toString());
  })().catch(async error => ({ error: error.message, stop: await engine.stopped }));
  await link.write(frame("out", 0, Buffer.from(JSON.stringify(rpc) + "\n"), true));
  assert.deepEqual(await received, response);
});
