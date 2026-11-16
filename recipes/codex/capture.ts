import { spawn, fork, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, appendFile, rename, access, realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";

const recipe = import.meta.dirname, repo = resolve(recipe, "../..");
const entry = join(repo, "packages/cli/src/capture.ts");
type Config = Record<string, any>;
const toml = (value: any): string => Array.isArray(value) ? `[${value.map(toml).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`).join(",")}}` : JSON.stringify(value);
async function run(command: string[], env = process.env): Promise<number> {
  const child = spawn(command[0]!, command.slice(1), { env, stdio: "inherit" });
  const forwards = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = forwards.map(signal => { const handler = () => child.kill(signal); process.on(signal, handler); return handler; });
  return new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      forwards.forEach((signal, i) => process.off(signal, handlers[i]!));
      if (signal) { process.kill(process.pid, signal); return; }
      done(code ?? 1);
    });
  });
}
async function sessions(home: string): Promise<string[]> {
  const root = join(home, "sessions");
  try { return (await readdir(root, { recursive: true, withFileTypes: true })).filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => join(e.parentPath, e.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function wrapped(plan: Config) {
  const overrides: string[] = [], proxies: ReturnType<typeof fork>[] = [];
  const set = (key: string, value: any) => overrides.push("-c", `${key}=${toml(value)}`);
  try {
    if (plan.routes.includes("mcp-proxy")) for (const [name, server] of Object.entries(plan.servers) as [string, Config][]) {
      if (server.enabled === false) continue;
      const prefix = `mcp_servers.${name}`;
      if (server.command) {
        set(`${prefix}.command`, process.execPath);
        set(`${prefix}.args`, [entry, "mcp-proxy", name, "--", server.command, ...server.args ?? []]);
        for (const key of ["PHOENIX_CAPTURE", "PHOENIX_COLLECTOR", "PHOENIX_HOME", "PHOENIX_CWD"]) set(`${prefix}.env.${key}`, process.env[key]);
        set(`${prefix}.env.PATH`, server.path ?? process.env.PATH);
      } else if (server.url && plan.reverse.includes(name)) {
        const child = fork(entry, ["mcp-http-proxy", name, server.url], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
        proxies.push(child);
        const port = await new Promise<number>((done, fail) => {
          const timer = setTimeout(() => fail(new Error("MCP proxy startup timed out")), 10_000);
          child.once("message", (value: any) => { clearTimeout(timer); done(value.port); });
          child.once("error", fail); child.once("exit", () => { clearTimeout(timer); fail(new Error("MCP proxy failed")); });
        });
        set(`${prefix}.url`, `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}${new URL(server.url).search}`);
      }
    }
    return await run(["codex", ...overrides, ...plan.args]);
  } finally { for (const proxy of proxies) proxy.kill("SIGTERM"); }
}
async function main() {
  if (process.argv[2] === "_run") return wrapped(JSON.parse(await readFile(process.argv[3]!, "utf8")));
  const split = process.argv.indexOf("--");
  if (split < 0) throw new Error("Use -- before Codex arguments");
  const { values } = parseArgs({ args: process.argv.slice(2, split), options: {
    "login-mode": { type: "string" }, routes: { type: "string" }, cwd: { type: "string" }, home: { type: "string" }, "reverse-mcp": { type: "string" },
  } });
  const modes = ["api-key", "chatgpt", "chatgpt-custom-provider", "custom-api-key", "custom-oauth", "command-auth", "local", "bedrock", "vertex"];
  if (!values["login-mode"] || !modes.includes(values["login-mode"])) throw new Error("Name the current --login-mode; no login or provider is changed");
  const args = process.argv.slice(split + 1);
  if (args[0] !== "exec" || args[1] === "resume" || args.some(a => a.startsWith("-c") || a.startsWith("-p") || a.startsWith("-C") || ["--config", "--profile", "--thread-source", "--cd", "--worktree", "--oss", "--ephemeral", "--ignore-user-config"].some(flag => a === flag || a.startsWith(flag + "=")))) throw new Error("Use fresh exec without routing/profile/cwd/thread overrides; set the recipe's --cwd or import explicitly");
  const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  if (version !== "codex-cli 0.169.0") throw new Error("Unsupported Codex version; import explicitly to retain unread records");
  if (["api-key", "chatgpt", "chatgpt-custom-provider"].includes(values["login-mode"])) execFileSync("codex", ["login", "status"], { stdio: "ignore" });
  const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const config: Config = JSON.parse(execFileSync("python3", ["-c", "import tomllib,json,sys,pathlib; p=pathlib.Path(sys.argv[1]); print(json.dumps(tomllib.loads(p.read_text()) if p.exists() else {}))", join(codexHome, "config.toml")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  if (config.profile) throw new Error("Capture needs an unprofiled config so endpoint coverage is explicit");
  const provider = config.model_provider ?? "openai", servers = config.mcp_servers ?? {};
  const routes = (values.routes ?? "mcp-proxy,cli-proxy,transcript").split(",");
  if (routes.some(r => !["mcp-proxy", "cli-proxy", "transcript"].includes(r))) throw new Error("Unknown capture route");
  if (routes.includes("mcp-proxy") && !Object.keys(servers).every(name => /^[a-zA-Z0-9_-]+$/.test(name))) throw new Error("Dotted/quoted MCP identifiers require transcript capture via explicit import");
  const cwd = await realpath(values.cwd ?? process.cwd());
  let projectRoot = cwd;
  try { projectRoot = await realpath(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); } catch {}
  let projectConfig = false;
  for (let dir = cwd; ; dir = dirname(dir)) {
    try { await access(join(dir, ".codex/config.toml")); projectConfig = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dir === projectRoot || dirname(dir) === dir) break;
  }
  if (projectConfig && routes.includes("mcp-proxy")) throw new Error("Project-local config can override routing; use transcript capture or explicit import");
  const reverse = (values["reverse-mcp"] ?? "").split(",").filter(Boolean);
  for (const name of reverse) if (!servers[name]?.url || servers[name].auth === "chatgpt") throw new Error("Reverse MCP requires a configured HTTP server without ChatGPT-bound authentication");
  const before = new Set(await sessions(codexHome));
  const home = resolve(values.home ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
  await mkdir(join(home, "runtime"), { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(home, "runtime", "codex-"));
  const id = randomUUID();
  let root = join(home, "captures", id);
  const sourceTag = `phoenix-${id}`;
  args.splice(1, 0, "--thread-source", sourceTag);
  try {
    const descriptor = parse(await readFile(join(recipe, "recipe.yaml"), "utf8")) as Config;
    delete descriptor.mcp;
    delete descriptor.transcript_reader;
    const contract = { phoenix_harness: 1, name: "codex", run: { command: ["codex", ...args], output: "stdout" }, endpoints: { model: { env: "OPENAI_BASE_URL" } }, editable: ["AGENTS.md"] };
    const routedServers = Object.fromEntries(Object.entries(servers).map(([name, server]) => {
      const value = server as Config;
      return [name, { ...Object.fromEntries(["enabled", "command", "args", "url"].filter(key => value[key] !== undefined).map(key => [key, value[key]])), ...(typeof value.env?.PATH === "string" ? { path: value.env.PATH } : {}) }];
    }));
    for (const [name, data] of Object.entries({ "recipe.json": descriptor, "contract.json": contract, "plan.json": { servers: routedServers, routes, reverse, args } })) await writeFile(join(temp, name), JSON.stringify(data), { mode: 0o600 });
    const code = await run([process.execPath, entry, "capture", "--recipe", join(temp, "recipe.json"), "--contract", join(temp, "contract.json"), "--cwd", cwd, "--output", root, "--routes", routes.join(","), "--", process.execPath, import.meta.filename, "_run", join(temp, "plan.json")], { ...process.env, PHOENIX_HOME: home });
    const captureId = JSON.parse(await readFile(join(root, "capture.json"), "utf8")).capture as string;
    const canonicalRoot = join(home, "captures", captureId);
    if (canonicalRoot !== root) { await rename(root, canonicalRoot); root = canonicalRoot; }
    await appendFile(join(root, "coverage.jsonl"), JSON.stringify({ recipe: "codex", version, login_mode: values["login-mode"], provider: projectConfig ? "project-config-not-resolved" : provider, routes, remote_mcp_fallback: Object.keys(servers).filter(n => servers[n].enabled !== false && servers[n].url && !reverse.includes(n)), limitations: ["Only PATH-resolved ls is shimmed; absolute paths, builtins and reset PATH bypass it", "Transcript items are not wire exchanges; no HTTP model bodies or MCP/CLI envelopes are invented", "Direct HTTP and plugin/dynamic MCP servers are not intercepted", "Filesystem side effects are not captured by CLI shims", "The harness's LLM traffic is not recorded", "A replay of a capture alone points Codex at its LLM through OPENAI_BASE_URL, which only the built-in OpenAI provider reads"] }) + "\n");
    let imported = false, incomplete = false;
    const importDescriptor = parse(await readFile(join(recipe, "recipe.yaml"), "utf8")) as Config;
    importDescriptor.transcript_reader.command = [process.execPath, join(recipe, "transcript-reader.ts"), "--single-run"];
    await writeFile(join(temp, "import.json"), JSON.stringify(importDescriptor), { mode: 0o600 });
    if (routes.includes("transcript")) for (const source of await sessions(codexHome)) if (!before.has(source)) {
      const header = JSON.parse((await readFile(source, "utf8")).split("\n", 1)[0]!);
      if (header.type !== "session_meta" || header.payload?.thread_source !== sourceTag) continue;
      imported = true;
      const result = await run([process.execPath, join(repo, "packages/cli/src/import.ts"), "--recipe", join(temp, "import.json"), "--home", home, "--capture", captureId, source]);
      incomplete ||= result !== 0;
    }
    if (routes.includes("transcript") && !imported) { await appendFile(join(root, "coverage.jsonl"), JSON.stringify({ gap: "no-new-session-file", reason: "Resumed, disabled, paginated or missing session logs require explicit import" }) + "\n"); incomplete = true; }
    process.stdout.write(JSON.stringify({ capture: root, harness_exit: code, transcript_imported: imported, incomplete }) + "\n");
    return code || (incomplete ? 1 : 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch { process.stderr.write("Codex recipe failed; no config, credentials or session payloads are logged\n"); process.exitCode = 1; }
}
