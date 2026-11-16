import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, readdir, symlink, appendFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const args = process.argv.slice(2);
const proxies = [];
const stopProxies = () => { for (const child of proxies) child.kill("SIGTERM"); };
const option = name => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const json = async file => {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
};

try {
  const capture = process.env.PHOENIX_CAPTURE;
  if (!capture) throw new Error("Run inside phoenix capture; after-the-fact capture needs only Pi and import");
  const { routes } = await json(join(capture, "capture.json"));
  const mcp = routes.includes("mcp-proxy");
  const source = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"));
  const runtime = await mkdtemp(join(tmpdir(), "phoenix-pi-"));
  const agent = join(runtime, "agent");
  await mkdir(agent, { mode: 0o700 });
  for (const name of await readdir(source)) {
    if (!["models.json", "settings.json", "mcp.json"].includes(name)) await symlink(join(source, name), join(agent, name));
  }
  for (const name of ["models.json", "settings.json"]) await writeFile(join(agent, name), JSON.stringify(await json(join(source, name))), { mode: 0o600 });
  const misses = [];
  const reverse = new Set((process.env.PHOENIX_PI_MCP_REVERSE ?? "").split(",").filter(Boolean));
  const phoenix = join(process.env.PATH.split(delimiter)[0], "phoenix");
  const proxy = async config => {
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      if (server.command) {
        server.args = ["mcp-proxy", name, "--", server.command, ...server.args ?? []];
        server.command = phoenix;
      } else if (server.url) {
        if (!reverse.has(name) || server.oauth || server.auth || ![undefined, "http", "streamable-http"].includes(server.type) || /\$\{|^!/.test(server.url)) {
          misses.push({ server: name, route: "transcript", reason: "remote OAuth, unsupported URL/transport, or no explicit reverse authorization; URL unchanged" });
          continue;
        }
        const upstream = new URL(server.url);
        if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.hash) throw new Error("Unsupported MCP URL");
        const child = spawn(phoenix, ["mcp-http-proxy", name, upstream.href], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
        proxies.push(child);
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("MCP HTTP proxy did not start")), 10_000);
          child.once("message", message => { clearTimeout(timer); resolve(message.port); });
          child.once("error", error => { clearTimeout(timer); reject(error); });
          child.once("exit", () => { clearTimeout(timer); reject(new Error("MCP HTTP proxy stopped")); });
        });
        server.url = `http://127.0.0.1:${port}${upstream.pathname}${upstream.search}`;
      }
    }
    return config;
  };
  let cwd = process.cwd();
  const selectsSession = args.some(arg => ["--continue", "-c", "--resume", "-r", "--session", "--session-id"].includes(arg));
  const adapter = option("--mcp-config");
  const globalMcp = await json(join(source, "mcp.json"));
  await writeFile(join(agent, "mcp.json"), JSON.stringify(mcp && !adapter ? await proxy(globalMcp) : globalMcp), { mode: 0o600 });
  if (mcp && adapter) {
    const file = join(runtime, "mcp.json");
    await writeFile(file, JSON.stringify(await proxy(JSON.parse(await readFile(resolve(adapter), "utf8")))), { mode: 0o600 });
    args[args.indexOf("--mcp-config") + 1] = file;
  } else if (mcp) {
    const project = join(cwd, ".pi");
    const config = await json(join(project, "mcp.json"));
    if (Object.keys(config).length && selectsSession) {
      misses.push({ route: "transcript", reason: "session selection keeps the original cwd; project MCP config is unchanged" });
    } else if (Object.keys(config).length) {
      const mirror = join(runtime, "cwd");
      await mkdir(join(mirror, ".pi"), { recursive: true, mode: 0o700 });
      for (const name of await readdir(cwd)) if (name !== ".pi") await symlink(join(cwd, name), join(mirror, name));
      for (const name of await readdir(project)) if (name !== "mcp.json") await symlink(join(project, name), join(mirror, ".pi", name));
      await writeFile(join(mirror, ".pi/mcp.json"), JSON.stringify(await proxy(config)), { mode: 0o600 });
      cwd = mirror;
    }
  }
  await appendFile(join(capture, "coverage.jsonl"), JSON.stringify({ recipe: "pi", routes, model: "transcript", mcp: mcp ? "configured stdio and explicitly authorized HTTP servers" : "transcript", limitations: misses, retained_overlay: runtime, cwd_overlay: cwd !== process.cwd() }) + "\n", { mode: 0o600 });
  process.stderr.write(`Pi private config overlay: ${runtime}\n`);
  const sessionCwd = resolve(process.env.PHOENIX_CWD ?? process.cwd());
  const sessionDir = join(source, "sessions", `--${sessionCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  const child = spawn("pi", args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR ?? sessionDir }, stdio: "inherit" });
  const signals = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, forward] of signals) process.on(signal, forward);
  child.on("error", () => { stopProxies(); process.stderr.write("Pi could not start\n"); process.exitCode = 127; });
  child.on("exit", (code, signal) => {
    stopProxies();
    for (const [name, forward] of signals) process.off(name, forward);
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  });
} catch {
  stopProxies();
  process.stderr.write("Pi recipe configuration failed; check config paths and supported routes\n");
  process.exitCode = 1;
}
