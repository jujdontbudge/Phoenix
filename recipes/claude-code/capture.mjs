import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const self = fileURLToPath(import.meta.url);
const run = (argv, options = {}) => new Promise((done, reject) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", ...options });
  const forwards = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, forward] of forwards) process.on(signal, forward);
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    for (const [name, forward] of forwards) process.off(name, forward);
    done({ code, signal });
  });
});
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = (path, data) => writeFile(path, JSON.stringify(data), { mode: 0o600 });

async function inside(path) {
  const config = await json(path), proxies = [];
  await save(join(config.temp, "capture.json"), { root: process.env.PHOENIX_CAPTURE });
  const servers = {};
  const phoenix = join(process.env.PATH.split(delimiter)[0], "phoenix");
  for (const file of config.mcp) Object.assign(servers, (await json(file)).mcpServers ?? {});
  const coverage = { model: "transcript only", mcp: {}, cli: config.routes.includes("cli-proxy") ? config.shim : [], limitations: ["Builtins and absolute command paths bypass PATH shims", "Native tools are available only as logged tool blocks", "Cloud connectors, plugins and unlisted MCP scopes are not proxied"], ...(config.claudeai ? { claudeai_connectors: "on for this run; direct; transcript only. Claude Code drops them under --strict-mcp-config, so MCP servers from the person's other scopes load too, direct and transcript only" } : {}) };
  try {
    for (const [name, server] of Object.entries(servers)) {
      if (!config.routes.includes("mcp-proxy")) { coverage.mcp[name] = "direct; transcript only"; continue; }
      if (server.command) {
        servers[name] = { ...server, command: phoenix, args: ["mcp-proxy", name, "--", server.command, ...(server.args ?? [])] };
        coverage.mcp[name] = "mcp-proxy stdio";
      } else if (server.type === "http" && config.remote.includes(name)) {
        const upstream = new URL(server.url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key, fallback) => {
          const value = process.env[key] ?? fallback;
          if (value === undefined) throw new Error("Missing MCP URL environment variable");
          return value;
        }));
        if (upstream.username || upstream.password || upstream.protocol !== "https:" && upstream.protocol !== "http:") throw new Error("Unsupported MCP URL");
        const child = spawn(phoenix, ["mcp-http-proxy", name, upstream.href], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        proxies.push(child);
        const port = await new Promise((done, reject) => {
          child.once("message", message => done(message.port));
          child.once("error", reject);
          child.once("exit", () => reject(new Error("MCP HTTP proxy stopped")));
        });
        servers[name] = { ...server, url: `http://127.0.0.1:${port}${upstream.pathname}${upstream.search}` };
        coverage.mcp[name] = "mcp-proxy HTTP; reverse explicitly authorized";
      } else coverage.mcp[name] = "direct; transcript only (OAuth/resource-bound, SSE/WebSocket, or no reverse authorization)";
    }
    await save(join(config.temp, "mcp.json"), { mcpServers: servers });
    await save(join(process.env.PHOENIX_CAPTURE, "recipe-coverage.json"), coverage);
    const env = { ...process.env };
    const settings = {};
    if (config.routes.includes("cli-proxy")) settings.PATH = env.PATH;
    if (config.claudeai) settings.ENABLE_CLAUDEAI_MCP_SERVERS = "true";
    return await run([...config.command, "--session-id", config.session, ...(config.claudeai ? [] : ["--strict-mcp-config"]), "--mcp-config", join(config.temp, "mcp.json"), "--settings", JSON.stringify({ env: settings }), ...config.args], { cwd: config.cwd, env });
  } finally { for (const child of proxies) child.kill("SIGTERM"); }
}

async function main() {
  if (process.argv[2] === "--inside") return inside(process.argv[3]);
  const split = process.argv.indexOf("--");
  const { values } = parseArgs({ args: process.argv.slice(2, split < 0 ? undefined : split), options: {
    "login-mode": { type: "string" }, home: { type: "string" }, cwd: { type: "string" }, routes: { type: "string" },
    mcp: { type: "string", multiple: true }, "remote-reverse": { type: "string", multiple: true }, shim: { type: "string" },
    phoenix: { type: "string" }, importer: { type: "string" }, claude: { type: "string" }, "claudeai-connectors": { type: "boolean" },
  } });
  const modes = ["api-key", "console", "subscription", "oauth-token", "auth-token", "api-key-helper", "profile-wif", "bedrock", "bedrock-bearer", "aws", "aws-bearer", "vertex", "foundry", "claude-apps-gateway", "managed"];
  if (!modes.includes(values["login-mode"])) throw new Error("Choose an explicit --login-mode; this recipe never changes credentials or providers");
  const command = JSON.parse(values.claude ?? '["claude"]');
  const version = spawnSync(command[0], [...command.slice(1), "--version"], { encoding: "utf8" });
  if (version.status !== 0 || !/^2\.1\.325\b/.test(version.stdout)) throw new Error("This recipe supports installed Claude Code 2.1.325 only; do not install or upgrade automatically");
  const auth = spawnSync(command[0], [...command.slice(1), "auth", "status"], { encoding: "utf8" });
  if (auth.status !== 0 || !JSON.parse(auth.stdout).loggedIn) throw new Error("Claude Code is not logged in; do not log in automatically");
  const cwd = await realpath(resolve(values.cwd ?? process.cwd())), home = resolve(values.home ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
  const mode = values["login-mode"];
  const routes = (values.routes ?? "mcp-proxy,cli-proxy,transcript").split(",");
  if (routes.some(route => !["mcp-proxy", "cli-proxy", "transcript"].includes(route))) throw new Error("Unsupported route: choose from mcp-proxy, cli-proxy and transcript");
  const setting = { vertex: "ANTHROPIC_VERTEX_BASE_URL", foundry: "ANTHROPIC_FOUNDRY_BASE_URL", "bedrock-bearer": "ANTHROPIC_BEDROCK_BASE_URL", "aws-bearer": "ANTHROPIC_AWS_BASE_URL" }[mode] ?? "ANTHROPIC_BASE_URL";
  const args = split < 0 ? [] : process.argv.slice(split + 1);
  if (args.some(arg => /^(--session-id|--resume|--continue|--no-session-persistence|--mcp-config|--strict-mcp-config|--settings)(=|$)/.test(arg) || ["-r", "-c"].includes(arg))) throw new Error("Session and config overrides are owned by this launcher; use transcript import for resumed sessions");
  await mkdir(join(home, "runtime"), { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(home, "runtime/claude-code-")), session = randomUUID();
  try {
    const shim = (values.shim ?? "ls,cat").split(",").filter(Boolean);
    const config = { cwd, temp, session, command, args, routes, shim, mcp: (values.mcp ?? []).map(file => resolve(file)), remote: values["remote-reverse"] ?? [], claudeai: !!values["claudeai-connectors"] };
    await save(join(temp, "config.json"), config);
    await save(join(temp, "recipe.json"), { phoenix_recipe: 1, name: "claude-code", harness_versions: ["2.1.325"], routes: [{ versions: "2.1.325", login_mode: mode, surfaces: { all: routes } }], shim });
    await save(join(temp, "harness.json"), { phoenix_harness: 1, name: "claude-code", run: { command }, endpoints: { model: { env: setting } }, editable: ["prompts/**"] });
    const live = routes.filter(route => route !== "transcript");
    const result = await run([...JSON.parse(values.phoenix ?? '["phoenix"]'), "capture", "--recipe", join(temp, "recipe.json"), "--contract", join(temp, "harness.json"), "--cwd", cwd, "--routes", live.join(","), "--", process.execPath, self, "--inside", join(temp, "config.json")], { env: { ...process.env, PHOENIX_HOME: home } });
    const { root } = await json(join(temp, "capture.json"));
    if (routes.includes("transcript")) {
      const source = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
      const imported = await run([...JSON.parse(values.importer ?? '["phoenix","import"]'), "--recipe", join(fileURLToPath(new URL(".", import.meta.url)), "recipe.yaml"), "--home", home, "--capture", (await json(join(root, "capture.json"))).capture, source]);
      if (imported.code !== 0) throw new Error("Transcript import incomplete; live evidence is retained");
    }
    process.stdout.write(JSON.stringify({ capture: root, coverage: join(root, "recipe-coverage.json") }) + "\n");
    return result;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

try {
  const result = await main();
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
} catch (error) {
  process.stderr.write(`Recipe failed: ${error instanceof Error && /^(Choose|This recipe|Claude Code is not|Unsupported route|Session and config|Transcript import)/.test(error.message) ? error.message : "configuration or child failure; no payload logged"}\n`);
  process.exitCode = 1;
}
