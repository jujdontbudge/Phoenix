import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { recognizeCommand } from "../packages/engine/src/index.ts";
import { pastCommand } from "../packages/runner/src/past-commands.ts";
import { resumeAttempt } from "../packages/runner/src/resume.ts";
import { createCapture, createTraceWriter } from "../packages/store/src/index.ts";

const at = "2026-11-16T20:33:40Z", cut = "2026-11-16T20:35:00Z", output = "[phoenix-test] captured output\n";
const plugin = connector => ({ phoenix_plugin: 1, connector, tier: "stateful", recognize: { commands: ["copycmd"] }, operations: ["copycmd", "tools/call:get"], read_only: ["copycmd list", "tools/call:get"] });
const shellAnswer = time => ({ id: "command", connector: "agent", op: "shell", args: { command: "copycmd list" }, result: { structuredContent: { output, exit_code: 0 } }, observed_at: time, before_cut: true });

async function snapshots(t, answers, descriptors, extra = {}) {
  const root = await mkdtemp(join(import.meta.dirname, ".past-commands-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "run"), sample = join(root, "sample");
  await mkdir(join(directory, "inputs/recipe"), { recursive: true });
  await mkdir(join(directory, "inputs/candidate"));
  await writeFile(join(directory, "inputs/recipe/recipe.json"), "{}");
  const script = join(root, "serve.mjs");
  await writeFile(script, `import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const request = JSON.parse(line);
      console.log(JSON.stringify({phoenix_plugin:1,id:request.id,status:'answer',value:request.method==='state'?{}:null}));
    }`);
  const plugins = [];
  for (const [index, descriptor] of descriptors.entries()) {
    await mkdir(join(directory, "inputs/plugins", String(index)), { recursive: true });
    plugins.push({ name: descriptor.connector, version: "1", image: "local-proof", descriptor: { ...descriptor, serve: { command: [process.execPath, script], protocol: "stdio", level: "tool" } } });
  }
  const sandbox = { async start(spec) {
    const mount = spec.mounts.find(m => spec.workdir === m.target);
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: mount?.source ?? root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, stdio: "pipe" });
    const exited = once(child, "close").then(([code, signal]) => ({ code, signal }));
    const channel = new PassThrough({ objectMode: true });
    return { channel, process: { id: "local-snapshot-proof", stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, interrupted: new Promise(() => {}), clock: { clock: "real", binaries: [] }, async stop() { if (child.exitCode === null) child.stdin.end(); await exited; channel.end(); } } };
  } };
  const moment = { cut_lines: 0, prompt: "[phoenix-test] snapshot", model: { provider: "proof", id: "proof" }, loadout: {}, cwd: root, answers, shell: { agent: { shell: { command: "command", output: "/structuredContent/output", exit: "/structuredContent/exit_code" } } }, ...extra };
  const outcome = await resumeAttempt({ id: "proof", capture: "proof", directory, root: sample, sandbox, hmacKey: Buffer.alloc(32, 1), started: async () => {},
    plan: { candidate_tree: "proof", harness_image: "local-proof", runner: { harness: { name: "proof" }, plugins, recipe: { name: "proof", file: "recipe.json", resume: { login: [process.execPath, "-e", ""], command: [process.execPath, "-e", ""], llm_hosts: { proof: ["example.invalid"] } } } } },
    bundle: { manifest: { clock: { time: cut }, resume: { moment: "moment", session: "session" } }, files: new Map([["moment", Buffer.from(JSON.stringify(moment))], ["session", Buffer.alloc(0)]]) },
  });
  assert.equal(outcome.kind, "finished", JSON.stringify(outcome));
  assert.equal(outcome.code, 0);
  const result = {};
  for (const descriptor of descriptors) result[descriptor.connector] = (await readFile(join(sample, "emulators", descriptor.connector, "inputs/snapshot"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  return result;
}

test("S33: a past command belongs only to the same first claimant as a new command", async t => {
  const descriptors = [plugin("first"), plugin("second")];
  assert.equal(recognizeCommand("copycmd list", descriptors).calls[0].connector, "first");
  const result = await snapshots(t, [shellAnswer(at)], descriptors);
  assert.equal(result.first.filter(event => event.op === "copycmd").length, 1);
  assert.deepEqual(result.second, []);
});

test("S34: past CLI calls and MCP answers are supplied in timestamp order", async t => {
  const early = { id: "get", connector: "copy", op: "get", args: {}, result: { content: [{ type: "text", text: "[phoenix-test] early" }] }, observed_at: at, before_cut: true };
  const late = shellAnswer("2026-11-16T20:34:00Z");
  const result = await snapshots(t, [late, early], [plugin("copy")]);
  const times = result.copy.filter(event => event.kind === "call" && !event.op.startsWith("frame:")).map(event => event.ts.wall);
  assert.deepEqual(times, [early.observed_at, late.observed_at]);
});

test("S34b: parallel shell parts exported by a recipe still become a chronological snapshot", async t => {
  const late = "2026-11-16T20:34:00Z";
  const rows = [
    { opencode_session: 1, info: { id: "synthetic", directory: "/synthetic" } },
    { info: { role: "user", model: { providerID: "opencode-go", modelID: "proof" }, time: { created: Date.parse(at) - 1000 } }, parts: [{ type: "text", text: "Earlier" }] },
    { info: { role: "assistant", time: { created: Date.parse(at) - 1000 } }, parts: [late, at].map((time, index) => ({ type: "tool", tool: "bash", callID: "command-" + index, state: { status: "completed", input: { command: "copycmd list", workdir: "/synthetic" }, output, metadata: { output, exit: 0 }, time: { end: Date.parse(time) } } })) },
    { info: { role: "user", model: { providerID: "opencode-go", modelID: "proof" }, time: { created: Date.parse(cut) } }, parts: [{ type: "text", text: "Now" }] },
  ];
  const extracted = spawnSync(process.execPath, [resolve("recipes/opencode/moment.mjs"), "--at", "4"], { input: rows.map(row => JSON.stringify(row)).join("\n") + "\n", encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(extracted.status, 0, extracted.stderr);
  const moment = JSON.parse(extracted.stdout);
  const result = await snapshots(t, moment.answers, [plugin("copy")], { shell: moment.shell });
  const times = result.copy.filter(event => event.kind === "call" && event.op === "copycmd").map(event => Date.parse(event.ts.wall));
  assert.deepEqual(times, [Date.parse(at), Date.parse(late)]);
});

test("S34c: chronological snapshots retain increasing sequence numbers in each capture stream", async t => {
  const late = { id: "late", connector: "copy", op: "get", args: {}, result: { content: [{ type: "text", text: "[phoenix-test] late" }] }, observed_at: "2026-11-16T20:34:00Z", before_cut: true };
  const early = { ...late, id: "early", observed_at: at };
  const result = await snapshots(t, [late, early], [plugin("copy")]);
  const root = await mkdtemp(join(import.meta.dirname, ".past-sequence-review-"));
  await createCapture(root, { capture: "proof", harness: { name: "proof", tree: "proof" }, recipe: { name: "proof", version: "1" }, routes: [], started_at: at, boot_id: "proof" });
  const writer = createTraceWriter(root, { capture: "proof", stream: "session" });
  t.after(async () => { await writer.close(); await rm(root, { recursive: true, force: true }); });
  assert.doesNotThrow(() => { for (const event of result.copy) writer.append(event); });
});

test("recipe shell output and exit pointers preserve a successful synthetic command", async t => {
  const fixtures = [
    { name: "claude-code", line: 6, rows: [
      { type: "user", message: { content: "Earlier" }, timestamp: at },
      { type: "api-request-shape", shapeHash: "shape", shape: { system: [{ text: "System" }], tools: [{ name: "Bash", input_schema: { type: "object" } }] } },
      { type: "api-request", shapeHash: "shape" },
      { type: "assistant", message: { model: "proof", content: [{ type: "tool_use", id: "command", name: "Bash", input: { command: "copycmd list" } }] } },
      { type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "command", content: output, is_error: false }] }, toolUseResult: { stdout: output, stderr: "" } },
      { type: "user", message: { content: "Now" }, timestamp: cut },
    ] },
    { name: "codex", line: 4, rows: [
      { type: "session_meta", payload: { cli_version: "0.169.0", account_scoped: true, id: "synthetic", timestamp: at } },
      { type: "turn_context", payload: { model: "proof", cwd: "/synthetic" } },
      { type: "event_msg", timestamp: at, payload: { type: "item_completed", item: { type: "CommandExecution", id: "command", command: ["/bin/sh", "-lc", "copycmd list"], cwd: "/synthetic", aggregated_output: output, exit_code: 0 } } },
      { type: "response_item", payload: { type: "message", role: "user" } },
      { type: "event_msg", timestamp: cut, payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Now" }] } } },
    ] },
    { name: "opencode", line: 4, rows: [
      { opencode_session: 1, info: { id: "synthetic", directory: "/synthetic" } },
      { info: { role: "user", model: { providerID: "opencode-go", modelID: "proof" }, time: { created: Date.parse(at) } }, parts: [{ type: "text", text: "Earlier" }] },
      { info: { role: "assistant", time: { created: Date.parse(at) } }, parts: [{ type: "tool", tool: "bash", callID: "command", state: { status: "completed", input: { command: "copycmd list", workdir: "/synthetic" }, output, metadata: { output, exit: 0 }, time: { end: Date.parse(at) } } }] },
      { info: { role: "user", model: { providerID: "opencode-go", modelID: "proof" }, time: { created: Date.parse(cut) } }, parts: [{ type: "text", text: "Now" }] },
    ] },
    { name: "pi", line: 6, rows: [
      { type: "session", version: 3, cwd: "/synthetic" },
      { type: "model_change", provider: "openai-codex", modelId: "proof" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Earlier" }] } },
      { type: "message", message: { role: "assistant", provider: "openai-codex", model: "proof", content: [{ type: "toolCall", id: "command", name: "bash", arguments: { command: "copycmd list" } }] } },
      { type: "message", timestamp: at, message: { role: "toolResult", toolCallId: "command", toolName: "bash", content: [{ type: "text", text: output }], isError: false } },
      { type: "message", timestamp: cut, message: { role: "user", content: [{ type: "text", text: "Now" }] } },
    ] },
  ];
  for (const fixture of fixtures) await t.test(fixture.name, () => {
    const extracted = spawnSync(process.execPath, [resolve("recipes", fixture.name, "moment.mjs"), "--at", String(fixture.line)], { input: fixture.rows.map(row => JSON.stringify(row)).join("\n") + "\n", encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(extracted.status, 0, extracted.stderr);
    const moment = JSON.parse(extracted.stdout);
    const answer = moment.answers.find(answer => answer.id === "command");
    const events = pastCommand(answer, moment.shell[answer.connector][answer.op], plugin("copy"), moment.cwd, { capture: "proof", stream: "command", connector: "copy" });
    assert.equal(events.find(event => event.op === "frame:back:1").body.inline, output);
    assert.equal(JSON.parse(events.find(event => event.op === "frame:back:3").body.inline).code, 0);
  });
});
