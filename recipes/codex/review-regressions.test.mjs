import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const recipe = import.meta.dirname;
const scratch = resolve(recipe, ".review");
await mkdir(scratch, { recursive: true });

async function fixture(config) {
  const root = await mkdtemp(join(scratch, "case-"));
  const home = join(root, "codex"), cwd = join(root, "task");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-review-key" }), { mode: 0o600 });
  await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store="file"\n' + config + "\n");
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, PHOENIX_HOME: join(root, "phoenix"), LANG: "en_US.UTF-8", TMPDIR: root };
  return { root, home, cwd, env, async close() { await rm(root, { recursive: true, force: true }); } };
}

async function origin() {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests.push({ method: req.method, path: req.url, upgrade: req.headers.upgrade });
    if (req.method !== "POST") { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"HTTP POST only"}'); return; }
    const message = { type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic reply", annotations: [] }] };
    const response = { id: "resp_synthetic", object: "response", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "synthetic reply" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, async close() { server.closeAllConnections(); server.close(); await once(server, "close"); } };
}

async function execute(file, args, env, cwd) {
  const child = spawn(file, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const out = [], err = [];
  child.stdout.on("data", b => out.push(b));
  child.stderr.on("data", b => err.push(b));
  const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  return { code, signal, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

test("S2 attached short config override cannot bypass the selected provider", async () => {
  const upstream = await origin(), bypass = await origin();
  const f = await fixture(`model="gpt-6.1-sol"\nmodel_provider="synthetic"\n[model_providers.synthetic]\nname="Synthetic local router"\nbase_url=${JSON.stringify(upstream.url)}\nwire_api="responses"\nsupports_websockets=false`);
  try {
    const result = await execute(process.execPath, [join(recipe, "capture.ts"), "--login-mode", "local", "--routes", "transcript", "--cwd", f.cwd, "--", "exec", `-cmodel_providers.synthetic.base_url=${JSON.stringify(bypass.url)}`, "--skip-git-repo-check", "synthetic override probe"], f.env, f.cwd);
    console.log(JSON.stringify({ code: result.code, signal: result.signal, selected: upstream.requests, bypass: bypass.requests }));
    assert.equal(bypass.requests.length, 0, "attached -c must be refused just like separated -c, before it changes the selected route");
  } finally { await f.close(); await upstream.close(); await bypass.close(); }
});

test("S3 Codex --cd cannot leave capture snapshot pointing at another directory", async () => {
  const upstream = await origin();
  const f = await fixture(`model="gpt-6.1-sol"\nmodel_provider="synthetic"\n[model_providers.synthetic]\nname="Synthetic local router"\nbase_url=${JSON.stringify(upstream.url)}\nwire_api="responses"\nsupports_websockets=false`);
  const actualCwd = join(f.root, "actual-task");
  await mkdir(actualCwd);
  await writeFile(join(actualCwd, "actual.txt"), "synthetic actual task file\n");
  try {
    const result = await execute(process.execPath, [join(recipe, "capture.ts"), "--login-mode", "local", "--routes", "transcript", "--cwd", f.cwd, "--", "exec", "--cd", actualCwd, "--skip-git-repo-check", "synthetic cwd probe"], f.env, f.cwd);
    if (result.code !== 0) return;
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1));
    const files = await readdir(join(summary.capture, "workdir"));
    const snapshot = JSON.parse(await readFile(join(summary.capture, "workdir", files[0]), "utf8"));
    console.log(JSON.stringify({ code: result.code, transcriptImported: summary.transcript_imported, incomplete: summary.incomplete, snapshotCwd: snapshot.path.split("/").at(-1), codexCwd: actualCwd.split("/").at(-1) }));
    assert.equal(snapshot.path, actualCwd, "successful capture must snapshot the directory Codex actually used (or reject --cd before launch)");
  } finally { await f.close(); await upstream.close(); }
});

test("S5 project-local MCP server is proxied or rejected explicitly", async () => {
  const upstream = await origin();
  const f = await fixture(`model="gpt-6.1-sol"\nmodel_provider="synthetic"\n[model_providers.synthetic]\nname="Synthetic local router"\nbase_url=${JSON.stringify(upstream.url)}\nwire_api="responses"\nsupports_websockets=false`);
  const marker = join(f.root, "project-mcp-started"), server = join(f.root, "project-mcp.mjs");
  await writeFile(server, `import { createInterface } from "node:readline";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\nfor await (const line of createInterface({input:process.stdin})) {\nconst req=JSON.parse(line); if (req.id===undefined) continue;\nconst result=req.method==="initialize"?{protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"synthetic-project",version:"1"}}:req.method==="tools/list"?{tools:[]}:{};\nprocess.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,result})+"\\n");\n}\n`);
  await execute("git", ["init", "--quiet", f.cwd], f.env, f.cwd);
  await writeFile(join(f.home, "config.toml"), await readFile(join(f.home, "config.toml"), "utf8") + `\n[projects.${JSON.stringify(f.cwd)}]\ntrust_level="trusted"\n`);
  await mkdir(join(f.cwd, ".codex"));
  await writeFile(join(f.cwd, ".codex", "config.toml"), `[mcp_servers.project_review]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(server)}]\n`);
  try {
    const direct = await execute("codex", ["exec", "--skip-git-repo-check", "synthetic project baseline"], f.env, f.cwd);
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(await readFile(marker, "utf8"), "started", "baseline Codex discovers project MCP server");
    await rm(marker);
    const captured = await execute(process.execPath, [join(recipe, "capture.ts"), "--login-mode", "local", "--routes", "mcp-proxy", "--cwd", f.cwd, "--", "exec", "--skip-git-repo-check", "synthetic project capture"], f.env, f.cwd);
    if (captured.code !== 0) return;
    assert.equal(await readFile(marker, "utf8"), "started");
    const summary = JSON.parse(captured.stdout.trim().split("\n").at(-1));
    const segments = await readdir(join(summary.capture, "seg"));
    const events = (await Promise.all(segments.filter(name => name.endsWith(".jsonl")).map(name => readFile(join(summary.capture, "seg", name), "utf8")))).join("\n").split("\n").filter(Boolean).map(text => JSON.parse(text));
    const proxied = events.filter(e => e.surface === "mcp" && e.connector === "project_review");
    console.log(JSON.stringify({ code: captured.code, projectServerStarted: true, projectServerTapEvents: proxied.length }));
    assert.ok(proxied.length > 0, "mcp-proxy must not silently leave effective project-local servers outside the capture");
  } finally { await f.close(); await upstream.close(); }
});

test("S4 stdio proxy preserves a server's configured PATH", async () => {
  const upstream = await origin();
  const f = await fixture(`model="gpt-6.1-sol"\nmodel_provider="synthetic"\n[model_providers.synthetic]\nname="Synthetic local router"\nbase_url=${JSON.stringify(upstream.url)}\nwire_api="responses"\nsupports_websockets=false`);
  const marker = join(f.root, "mcp-path.txt"), server = join(f.root, "mcp.mjs");
  const configuredPath = `${join(f.root, "server-tools")}:${process.env.PATH}`;
  await writeFile(server, `import { createInterface } from "node:readline";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.env.PATH);\nfor await (const line of createInterface({input:process.stdin})) {\nconst req=JSON.parse(line); if (req.id===undefined) continue;\nconst result=req.method==="initialize"?{protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"synthetic-review",version:"1"}}:req.method==="tools/list"?{tools:[]}:{};\nprocess.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,result})+"\\n");\n}\n`);
  await writeFile(join(f.home, "config.toml"), await readFile(join(f.home, "config.toml"), "utf8") + `\n[mcp_servers.review]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(server)}]\n[mcp_servers.review.env]\nPATH=${JSON.stringify(configuredPath)}\n`);
  try {
    const direct = await execute("codex", ["exec", "--skip-git-repo-check", "synthetic MCP baseline"], f.env, f.cwd);
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(await readFile(marker, "utf8"), configuredPath, "baseline Codex honors this server PATH");
    await rm(marker);
    const captured = await execute(process.execPath, [join(recipe, "capture.ts"), "--login-mode", "local", "--routes", "mcp-proxy", "--cwd", f.cwd, "--", "exec", "--skip-git-repo-check", "synthetic MCP capture"], f.env, f.cwd);
    assert.equal(captured.code, 0, captured.stderr);
    const actualPath = await readFile(marker, "utf8");
    console.log(JSON.stringify({ baselineHasServerTools: true, capturedHasServerTools: actualPath.includes(join(f.root, "server-tools")) }));
    assert.ok(actualPath.split(":").includes(join(f.root, "server-tools")), "proxy injection must not discard the server's explicitly configured PATH");
  } finally { await f.close(); await upstream.close(); }
});

test("S4b combined MCP and CLI capture preserves server-specific executable resolution", async () => {
  const upstream = await origin();
  const f = await fixture(`model="gpt-6.1-sol"\nmodel_provider="synthetic"\n[model_providers.synthetic]\nname="Synthetic local router"\nbase_url=${JSON.stringify(upstream.url)}\nwire_api="responses"\nsupports_websockets=false`);
  const bin = join(f.root, "server-tools"), marker = join(f.root, "resolved-ls.txt"), server = join(f.root, "mcp.mjs");
  await mkdir(bin);
  await writeFile(join(bin, "ls"), `#!${process.execPath}\nprocess.stdout.write("synthetic server-specific executable\\n");\n`);
  await chmod(join(bin, "ls"), 0o700);
  await writeFile(server, `import { createInterface } from "node:readline";\nimport { writeFileSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\nwriteFileSync(${JSON.stringify(marker)}, execFileSync("ls", [], {encoding:"utf8"}));\nfor await (const line of createInterface({input:process.stdin})) {\nconst req=JSON.parse(line); if (req.id===undefined) continue;\nconst result=req.method==="initialize"?{protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"synthetic-resolution",version:"1"}}:req.method==="tools/list"?{tools:[]}:{};\nprocess.stdout.write(JSON.stringify({jsonrpc:"2.0",id:req.id,result})+"\\n");\n}\n`);
  await writeFile(join(f.home, "config.toml"), await readFile(join(f.home, "config.toml"), "utf8") + `\n[mcp_servers.review]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(server)}]\n[mcp_servers.review.env]\nPATH=${JSON.stringify(`${bin}:${process.env.PATH}`)}\n`);
  try {
    const direct = await execute("codex", ["exec", "--skip-git-repo-check", "synthetic executable baseline"], f.env, f.cwd);
    assert.equal(direct.code, 0, direct.stderr);
    const baseline = await readFile(marker, "utf8");
    assert.equal(baseline, "synthetic server-specific executable\n");
    await rm(marker);
    const captured = await execute(process.execPath, [join(recipe, "capture.ts"), "--login-mode", "local", "--routes", "mcp-proxy,cli-proxy", "--cwd", f.cwd, "--", "exec", "--skip-git-repo-check", "synthetic executable capture"], f.env, f.cwd);
    assert.equal(captured.code, 0, captured.stderr);
    const result = await readFile(marker, "utf8");
    console.log(JSON.stringify({ baselineOutput: baseline, capturedOutput: result }));
    assert.equal(result, baseline, "adding CLI capture must not substitute the launcher's executable for the MCP server's configured executable");
  } finally { await f.close(); await upstream.close(); }
});
