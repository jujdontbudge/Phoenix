import { chmod, mkdir, readFile, readdir, symlink, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve, delimiter, relative, isAbsolute } from "node:path";
import { parse } from "yaml";
import { validate, type HarnessContract, type RecipeDescriptor } from "@phoenix/formats";

export async function readDescriptor(path: string, kind: "recipe"): Promise<RecipeDescriptor>;
export async function readDescriptor(path: string, kind: "harness"): Promise<HarnessContract>;
export async function readDescriptor(path: string, kind: "recipe" | "harness") {
  const result = validate(kind, parse(await readFile(path, "utf8")));
  if (!result.ok) throw new Error(`Invalid ${kind}: ${result.errors.join("; ")}`);
  return result.value;
}

export async function executable(name: string, path = process.env.PATH ?? ""): Promise<string> {
  for (const dir of path.split(delimiter)) {
    const file = resolve(dir, name);
    try { await access(file, constants.X_OK); return file; } catch {}
  }
  throw new Error(`Cannot find configured command: ${name}`);
}

export async function applyRecipe(options: {
  cwd: string; runtime: string; entry: string; recipe: RecipeDescriptor; contract: HarnessContract;
  routes: string[]; env: NodeJS.ProcessEnv;
}) {
  const { recipe, contract, routes, runtime, entry } = options;
  const env: NodeJS.ProcessEnv = { ...options.env }, bin = join(runtime, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const launcher = `#!${process.execPath}\nimport { main } from ${JSON.stringify(entry)};\nawait main(process.argv.slice(2));\n`;
  await writeFile(join(bin, "phoenix"), launcher, { mode: 0o700 });
  for (const name of routes.includes("cli-proxy") ? recipe.shim ?? [] : []) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "phoenix") throw new Error("Invalid shim name");
    const real = await executable(name, options.env.PATH);
    await writeFile(join(bin, name), `#!${process.execPath}\nimport { main } from ${JSON.stringify(entry)};\nawait main(["cli-shim", ${JSON.stringify(name)}, ${JSON.stringify(real)}, ...process.argv.slice(2)]);\n`, { mode: 0o700 });
  }
  env.PATH = `${bin}${delimiter}${options.env.PATH ?? ""}`;
  let cwd = options.cwd;
  const mcp = contract.endpoints?.mcp ?? recipe.mcp;
  if (mcp && routes.includes("mcp-proxy")) {
    if (mcp.format !== "mcpServers") throw new Error("Generic recipe needs the mcpServers JSON format");
    const rel = relative(options.cwd, resolve(options.cwd, mcp.file));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("MCP config must be inside the working directory");
    const config = JSON.parse(await readFile(resolve(options.cwd, mcp.file), "utf8")) as { mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> };
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (server.command) config.mcpServers[name] = { ...server, command: process.execPath, args: [entry, "mcp-proxy", name, "--", server.command, ...server.args ?? []], env: { ...Object.fromEntries(["PATH", "PHOENIX_CAPTURE", "PHOENIX_COLLECTOR", "PHOENIX_HOME", "PHOENIX_CWD", "PHOENIX_COPY_IGNORED"].map(key => [key, env[key]!])), ...server.env } };
      else throw new Error(`The MCP proxy covers local (stdio) MCP servers only, and ${name} is a remote one`);
    }
    cwd = join(runtime, "cwd");
    const mirror = async (source: string, destination: string, configPath: string): Promise<void> => {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      const [part, ...rest] = configPath.split("/");
      for (const item of await readdir(source)) {
        if (item !== part) await symlink(join(source, item), join(destination, item));
        else if (rest.length) await mirror(join(source, item), join(destination, item), rest.join("/"));
        else { await writeFile(join(destination, item), JSON.stringify(config), { mode: 0o600 }); await chmod(join(destination, item), 0o600); }
      }
    };
    await mirror(options.cwd, cwd, rel);
  }
  return { cwd, env, bin };
}
