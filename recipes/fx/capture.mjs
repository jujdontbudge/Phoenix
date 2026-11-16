import { spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

let temporary, signalToRaise;
try {
  const args = process.argv.slice(2), split = args.indexOf("--");
  if (split < 0 || !args[split + 1]) throw new Error("Name a command after --");
  const { values } = parseArgs({ args: args.slice(0, split), options: { cwd: { type: "string" }, contract: { type: "string" }, output: { type: "string" }, routes: { type: "string" }, "copy-ignored": { type: "boolean" } } });
  const cwd = resolve(values.cwd ?? process.cwd()), routes = values.routes ?? "mcp-proxy,cli-proxy";
  const recipe = JSON.parse(await readFile(new URL("./recipe.yaml", import.meta.url), "utf8"));
  const contract = JSON.parse(await readFile(resolve(cwd, values.contract ?? "phoenix.harness.yaml"), "utf8"));
  delete recipe.mcp;
  delete contract.endpoints.mcp;
  temporary = await mkdtemp(join(tmpdir(), "phoenix-fx-launch-"));
  await writeFile(join(temporary, "recipe.json"), JSON.stringify(recipe), { mode: 0o600 });
  await writeFile(join(temporary, "contract.json"), JSON.stringify(contract), { mode: 0o600 });
  const command = args.slice(split + 1);
  const phoenix = JSON.parse(process.env.PHOENIX_COMMAND ?? '["phoenix"]');
  const child = spawn(phoenix[0], [...phoenix.slice(1), "capture", "--recipe", join(temporary, "recipe.json"), "--contract", join(temporary, "contract.json"), "--cwd", cwd, "--routes", routes, ...(values.output ? ["--output", resolve(values.output)] : []), ...(values["copy-ignored"] ? ["--copy-ignored"] : []), "--", ...command], { env: { ...process.env, PHOENIX_FX_MCP_PROXY: String(routes.split(",").includes("mcp-proxy")) }, stdio: "inherit" });
  const handlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise(resolve => { child.on("exit", (code, signal) => resolve({ code, signal })); child.on("error", () => resolve({ code: 127 })); });
  process.exitCode = result.code ?? 1;
  for (const [signal, handler] of handlers) process.off(signal, handler);
  signalToRaise = result.signal;
} catch {
  process.stderr.write("fx capture requires a JSON harness contract and a working Phoenix command; no config content is logged\n");
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
if (signalToRaise) process.kill(process.pid, signalToRaise);
