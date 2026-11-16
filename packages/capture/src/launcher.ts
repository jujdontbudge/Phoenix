import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readdir, lstat, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { appendCoverage, createCapture, digest } from "@phoenix/store";
import { applyRecipe, readDescriptor } from "./recipe.ts";
import { capturePlugin, type PluginCaptureOptions } from "./plugin-capture.ts";

export interface CaptureOptions {
  cwd?: string; home?: string; root?: string; recipe: string; contract?: string;
  routes?: string[]; copyIgnored?: boolean; command: string[]; entry: string;
  plugins?: Omit<PluginCaptureOptions, "root" | "home">[];
}
export async function launch(options: CaptureOptions) {
  const cwd = resolve(options.cwd ?? process.cwd()), home = resolve(options.home ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
  const recipe = await readDescriptor(options.recipe, "recipe"), contractPath = resolve(cwd, options.contract ?? "phoenix.harness.yaml");
  const contract = await readDescriptor(contractPath, "harness");
  const routes = options.routes ?? ["mcp-proxy", "cli-proxy"];
  const offered = new Set(recipe.routes.flatMap(route => Object.values(route.surfaces).flat()));
  for (const route of routes) if (!offered.has(route) || !["mcp-proxy", "cli-proxy"].includes(route)) throw new Error(`Recipe does not offer route: ${route}`);
  const id = randomUUID(), root = resolve(options.root ?? join(home, "captures", id));
  const started = new Date().toISOString();
  let tree: Buffer;
  let treeIncomplete = false;
  try { tree = (await promisify(execFile)("git", ["ls-tree", "-rz", "HEAD"], { cwd, encoding: "buffer" })).stdout; }
  catch {
    let repository: string | undefined;
    try {
      repository = await mkdtemp(join(tmpdir(), "phoenix-harness-"));
      await promisify(execFile)("git", ["init", "-q", repository]);
      const gitDirectory = join(repository, ".git");
      const git = (args: string[]) => promisify(execFile)("git", ["--git-dir", gitDirectory, "--work-tree", cwd, ...args], { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      await git(["add", "-A"]);
      const hash = (await git(["write-tree"])).stdout.toString().trim();
      tree = (await git(["ls-tree", "-rz", hash])).stdout;
    } catch {
      tree = Buffer.from(`unavailable-harness-tree:${id}`);
      treeIncomplete = true;
    } finally { if (repository) await rm(repository, { recursive: true, force: true }).catch(() => {}); }
  }
  await createCapture(root, { capture: id, harness: { name: contract.name, tree: digest(tree) }, recipe: { name: recipe.name, version: String(recipe.phoenix_recipe) }, routes,
    ...(recipe.task_keys?.length ? { task_key: recipe.task_keys } : {}), started_at: started, boot_id: (await promisify(execFile)("sysctl", ["-n", "kern.boottime"]).catch(() => ({ stdout: "unknown" }))).stdout.trim() });
  if (treeIncomplete) await appendCoverage(root, { gap: "harness-tree-unavailable" });
  await mkdir(join(home, "runtime"), { recursive: true, mode: 0o700 });
  const runtime = await mkdtemp(join(home, "runtime", "capture-"));
  const socket = join(runtime, "collector.sock");
  const env: NodeJS.ProcessEnv = { ...process.env, PHOENIX_HOME: home, PHOENIX_CAPTURE: root, PHOENIX_COLLECTOR: socket, PHOENIX_CWD: cwd, PHOENIX_COPY_IGNORED: String(options.copyIgnored ?? recipe.copy_ignored ?? false) };
  let stopping = false;
  let retainRuntime = false;
  const children = new Set<ChildProcess>();
  const start = (mode: string, extra: string[] = [], childEnv = env): ChildProcess => {
    const argv = [options.entry, mode, ...extra];
    const child = spawn(mode === "snapshot" && process.platform === "darwin" ? "taskpolicy" : process.execPath, mode === "snapshot" && process.platform === "darwin" ? ["-b", process.execPath, ...argv] : argv, { env: childEnv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.add(child); child.once("exit", () => children.delete(child)); return child;
  };
  const ready = (child: ChildProcess) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Capture route did not start")), 10_000);
    child.once("message", message => { clearTimeout(timer); resolve(message as Record<string, unknown>); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Capture route failed to start")); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Capture route could not start")); });
  });
  const superviseCollector = () => {
    const child = start("collector");
    child.once("exit", () => { if (!stopping) setTimeout(() => { if (!stopping) superviseCollector(); }, 100).unref(); });
    return child;
  };
  try {
    await ready(superviseCollector()).catch(async () => { await appendCoverage(root, { gap: "collector-unavailable-at-launch" }); });
    const overlay = await applyRecipe({ cwd, runtime, entry: options.entry, recipe, contract, routes, env });
    await writeFile(join(runtime, "snapshot.json"), JSON.stringify({ root, cwd, run: "default", home, started, copyIgnored: options.copyIgnored ?? recipe.copy_ignored ?? false }), { mode: 0o600 });
    process.stderr.write(`Capture: ${root}\n`);
    const harness = spawn(options.command[0]!, options.command.slice(1), { cwd: overlay.cwd, env: overlay.env, stdio: "inherit" });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      harness.once("exit", (code, signal) => resolve({ code, signal }));
      harness.once("error", () => resolve({ code: 127, signal: null }));
    });
    const forwards = new Map<NodeJS.Signals, () => void>();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) { const forward = () => harness.kill(signal); forwards.set(signal, forward); process.on(signal, forward); }
    const snapshot = start("snapshot", [join(runtime, "snapshot.json")]);
    const snapshotDone = new Promise<void>(resolve => { snapshot.once("exit", () => resolve()); snapshot.once("error", () => resolve()); });
    const result = await exit;
    for (const [signal, forward] of forwards) process.off(signal, forward);
    await snapshotDone;
    if (overlay.cwd !== cwd) {
      const hasNewFiles = async (dir: string, original: string): Promise<boolean> => {
        for (const name of await readdir(dir)) {
          const file = join(dir, name), stat = await lstat(file);
          if (stat.isSymbolicLink()) continue;
          try { await access(join(original, name)); } catch { return true; }
          if (stat.isDirectory() && await hasNewFiles(file, join(original, name))) return true;
        }
        return false;
      };
      retainRuntime = await hasNewFiles(overlay.cwd, cwd);
    }
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    await Promise.all([...children].map(child => new Promise<void>(resolve => child.once("exit", () => resolve()))));
    await appendCoverage(root, { state: "closed", at: new Date().toISOString(), exit: result, configured: routes,
      ...(retainRuntime ? { retained_overlay: overlay.cwd } : {}),
      limitations: ["Absolute-path commands and shell builtins bypass CLI shims", "CLI results do not capture filesystem side effects", "The harness's LLM traffic is not recorded", "New files in a generated config overlay remain in the retained overlay", "Provider-held history and unproxied surfaces need later coverage assessment"] });
    for (const plugin of options.plugins ?? []) await capturePlugin({ ...plugin, root, home }).catch(() => {});
    return { root, ...result };
  } finally {
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    if (!retainRuntime) await rm(runtime, { recursive: true, force: true });
  }
}
