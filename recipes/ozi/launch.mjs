import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "source-home": { type: "string", default: process.env.OZI_HOME ?? join(homedir(), ".ozi") },
    home: { type: "string" }, instance: { type: "string" }, driver: { type: "string" },
    "mcp-file": { type: "string" },
  } });

  if (!values.home || !values.instance || !values.driver || !positionals.length) throw new Error("Name --home, --instance, --driver and -- ozi serve arguments");
  if (positionals.some(arg => ["--home", "--base-dir"].includes(arg) || /^(?:--home|--base-dir)=/.test(arg))) throw new Error("The recipe owns the isolated --home argument");
  const home = resolve(values.home), sourceHome = resolve(values["source-home"]);
  if (home === sourceHome) throw new Error("The capture home must differ from the existing home");
  let settings = {};
  try { settings = JSON.parse(await readFile(join(sourceHome, "userdata/settings.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const previous = settings.providerInstances?.[values.instance] ?? { driver: values.driver, config: {} };
  if (previous.driver !== values.driver) throw new Error("The selected instance uses another driver");
  if (previous.config?.setupMode === "managed") throw new Error("Managed provider credentials remain in the existing home; use its transcript route");
  if (values.driver === "codex" && previous.config?.setupMode !== "existing") throw new Error("Select an existing-mode Codex instance explicitly; the managed default cannot be redirected");
  const instance = structuredClone(previous);
  instance.config ??= {};
  if ((instance.environment ?? []).some(entry => entry.valueRedacted === true) || JSON.stringify(instance.config).includes('"••••••"')) throw new Error("Native credentials remain in the existing Ozi secret store; use its transcript route");
  const environment = new Map((instance.environment ?? []).map(entry => [entry.name, entry]));
  environment.set("PATH", { name: "PATH", value: process.env.PATH ?? "", sensitive: false });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  if (values["mcp-file"]) {
    const file = resolve(values["mcp-file"]);
    const config = JSON.parse(await readFile(file, "utf8"));
    if (!config.mcpServers || typeof config.mcpServers !== "object") throw new Error("Expected an mcpServers JSON overlay");
    if (Object.hasOwn(config.mcpServers, "t3-code")) throw new Error("Ozi owns t3-code; its injected MCP endpoint uses transcript fallback");
    if (values.driver === "claudeAgent") instance.config.launchArgs = `${instance.config.launchArgs ?? ""} --mcp-config ${quote(file)}`.trim();
    else if (values.driver === "codex") {
      const toml = value => {
        if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`).join(",")}}`;
        throw new Error("Unsupported native MCP configuration value");
      };
      const args = `-c ${quote(`mcp_servers=${toml(config.mcpServers)}`)}`;
      const nativeArgs = (environment.get("OZI_CODEX_LAUNCH_ARGS")?.value ?? process.env.OZI_CODEX_LAUNCH_ARGS)?.trim() || instance.config.launchArgs?.trim() || "";
      instance.config.launchArgs = `${nativeArgs} ${args}`.trim();
      environment.set("OZI_CODEX_LAUNCH_ARGS", { name: "OZI_CODEX_LAUNCH_ARGS", value: instance.config.launchArgs, sensitive: false });
    } else throw new Error("This driver has no demonstrated external MCP launch-argument route; use its transcript");
  }
  instance.environment = [...environment.values()];
  settings.providerInstances = { [values.instance]: instance };
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(home, "userdata"), { mode: 0o700 });
  await writeFile(join(home, "userdata/settings.json"), JSON.stringify(settings), { mode: 0o600, flag: "wx" });
  const child = spawn(positionals[0], [...positionals.slice(1), "--home", home], { env: { ...process.env, OZI_HOME: home }, stdio: "inherit" });
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.once("error", () => { process.stderr.write("Ozi could not start\n"); process.exitCode = 127; });
  child.once("exit", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  });
}

await main().catch(() => { process.stderr.write("Ozi capture configuration failed; no source values logged\n"); process.exitCode = 1; });
