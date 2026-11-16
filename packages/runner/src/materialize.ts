import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { validate, type Bindings, type HarnessContract, type TraceEvent } from "@phoenix/formats";
import { digest, type MomentBundle } from "@phoenix/store";

export interface TreeInput { digest: string; directory: string }

export interface MaterializeOptions {
  bundle: MomentBundle;
  base: TreeInput;
  candidate: TreeInput;
  contract: HarnessContract;
  bindings?: Bindings;
  directory: string;
  env?: Readonly<Record<string, string>>;
  llm: string;
}

export interface MaterializedTree {
  directory: string;
  support: string;
  argv: string[];
  env: Record<string, string>;
  routes: { mcp: Record<string, string>; mcpHttp: Record<string, string>; http: Record<string, string>; cli: Record<string, string> };
}

type Entry = { mode: number; bytes?: Buffer; link?: boolean };
type Tree = Map<string, Entry>;
type Invocation = { argv: string[]; cwd: string; env: Record<string, string> };

function pathInside(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === ".."))
    throw new Error(`Not a tree-relative path: ${path}`);
  return join(root, path);
}

async function readTree(directory: string): Promise<Tree> {
  const tree: Tree = new Map();
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`Tree is not a plain directory: ${directory}`);
  const visit = async (prefix: string): Promise<void> => {
    for (const name of (await readdir(join(directory, prefix))).sort()) {
      if (name === ".git") continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const source = pathInside(directory, path);
      const stat = await lstat(source);
      if (stat.isDirectory()) {
        tree.set(path, { mode: stat.mode & 0o7777 });
        await visit(path);
      } else if (stat.isFile()) {
        const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error(`Tree changed while reading: ${path}`);
          const bytes = await file.readFile();
          const after = await file.stat();
          if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs)
            throw new Error(`Tree changed while reading: ${path}`);
          tree.set(path, { mode: opened.mode & 0o7777, bytes });
        } finally { await file.close(); }
      } else if (stat.isSymbolicLink()) tree.set(path, { mode: 0o777, bytes: Buffer.from(await readlink(source)), link: true });
      else throw new Error(`Tree contains a special file: ${path}`);
    }
  };
  await visit("");
  return tree;
}

function hashTree(tree: Tree): string {
  const rows = [...tree].filter(([, entry]) => entry.bytes !== undefined)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, entry]) => {
      const bytes = entry.bytes!;
      const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      return `${entry.link ? "120000" : entry.mode & 0o100 ? "100755" : "100644"} blob ${hash}\t${path}\0`;
    });
  return digest(rows.join(""));
}

export async function treeDigest(directory: string): Promise<string> {
  return hashTree(await readTree(directory));
}

function lockedFile(bundle: MomentBundle, path: string): Buffer {
  pathInside(bundle.root, path);
  const bytes = bundle.files.get(path);
  if (!bytes || bundle.lock.data[path] !== digest(bytes)) throw new Error(`Missing or changed locked data: ${path}`);
  return Buffer.from(bytes);
}

function blob(bundle: MomentBundle, hash: string): Buffer {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid snapshot blob digest: ${hash}`);
  const bytes = lockedFile(bundle, `data/blobs/${hash.slice(7)}`);
  if (digest(bytes) !== hash) throw new Error(`Snapshot blob hash mismatch: ${hash}`);
  return bytes;
}

function events(bundle: MomentBundle, connector: string): TraceEvent[] {
  const result: TraceEvent[] = [];
  for (const ref of bundle.manifest.connectors?.[connector]?.data ?? []) {
    if (ref.kind !== "run-evidence") continue;
    for (const line of lockedFile(bundle, ref.path).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = validate("trace", JSON.parse(line));
      if (!event.ok) throw new Error(`Invalid run evidence ${ref.path}: ${event.errors.join("; ")}`);
      if (event.value.connector === connector) result.push(event.value);
    }
  }
  return result;
}

function cliInvocation(bundle: MomentBundle, evidence: TraceEvent[], connector: string): Invocation {
  for (const event of evidence) {
    if (event.kind !== "meta" || event.op !== "open" || !event.body) continue;
    const bytes = "inline" in event.body ? Buffer.from(event.body.inline) : "blob" in event.body ? blob(bundle, event.body.blob) : undefined;
    if (!bytes) continue;
    const body = JSON.parse(bytes.toString("utf8")) as { meta?: Partial<Invocation> } & Partial<Invocation>;
    const value = body.meta ?? body;
    if (Array.isArray(value.argv) && value.argv.length && value.argv.every(arg => typeof arg === "string") && typeof value.cwd === "string" && value.env && typeof value.env === "object" && !Array.isArray(value.env) && Object.values(value.env).every(v => typeof v === "string"))
      return value as Invocation;
    throw new Error(`Invalid CLI invocation evidence: ${connector}`);
  }
  throw new Error(`Missing recorded CLI invocation metadata: ${connector}`);
}

const mcpShim = `import { connect } from "node:net";
const socket = connect({ host: process.argv[2], port: 8080 });
socket.on("error", error => { process.stderr.write(error.message + "\\n"); process.exitCode = 1; process.stdin.destroy(); });
process.stdin.on("error", () => socket.destroy());
process.stdout.on("error", () => socket.destroy());
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.stdin.destroy());
`;

const cliShim = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { WriteStream } from "node:tty";
import { openSync, closeSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("../cli.json", import.meta.url), "utf8"))[basename(process.argv[1])];
const socket = connect({ host: config.host, port: 8080 });
const lines = createInterface({ input: socket });
let finished = false;
const send = value => socket.write(JSON.stringify(value) + "\\n");
const frame = (stream, bytes, last) => send({ stream, bytes: Buffer.from(bytes).toString("base64"), last });
const size = stream => {
  if (!stream.isTTY) return null;
  const fd = openSync("/dev/fd/" + stream.fd, "r");
  let tty;
  try { tty = new WriteStream(fd); const [columns, rows] = tty.getWindowSize(); return { columns, rows }; }
  finally { if (tty) tty.destroy(); else closeSync(fd); }
};
const terminals = { stdin: size(process.stdin), stdout: size(process.stdout), stderr: size(process.stderr) };
const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGCONT"];
const listeners = new Map();
const wasRaw = process.stdin.isRaw;
const cleanup = () => {
  process.stdin.pause();
  if (terminals.stdin) process.stdin.setRawMode(wasRaw ?? false);
  for (const [signal, listener] of listeners) process.off(signal, listener);
};
const fail = error => {
  if (finished) return;
  finished = true;
  cleanup();
  process.stderr.write(error.message + "\\n");
  socket.destroy();
  process.exitCode = 1;
};
socket.on("error", fail);
socket.on("close", () => { if (!finished) fail(new Error("CLI replay closed without an exit status")); });
lines.on("line", line => {
  try {
    const value = JSON.parse(line);
    const bytes = Buffer.from(value.bytes, "base64");
    if (value.stream === 1 || value.stream === 2) {
      const output = value.stream === 1 ? process.stdout : process.stderr;
      if (!output.write(bytes)) { socket.pause(); output.once("drain", () => socket.resume()); }
    } else if (value.stream === 3) {
      const exit = JSON.parse(bytes.toString("utf8"));
      if (exit.type !== "exit" || (exit.code === null && !exit.signal)) throw new Error("Invalid CLI exit status");
      finished = true;
      cleanup();
      socket.end();
      socket.destroy();
      if (exit.signal) {
        process.stdout.write("", () => process.stderr.write("", () => process.kill(process.pid, exit.signal)));
      } else process.exitCode = exit.code;
    } else throw new Error("Unknown CLI replay stream");
  } catch (error) { fail(error); }
});
socket.on("connect", () => {
  const env = {};
  for (const [key, captured] of Object.entries(config.env)) {
    const actual = process.env[key];
    if (actual === undefined) continue;
    env[key] = key === "PATH" && actual === config.path ? captured : actual;
  }
  const cwd = process.cwd();
  if (cwd !== "/worktree" && !cwd.startsWith("/worktree/")) { fail(new Error("CLI invocation is outside /worktree")); return; }
  send({ argv: [config.argv0, ...process.argv.slice(2)], cwd: posix.join(config.cwd, posix.relative("/worktree", cwd)), env, terminals });
  for (const signal of signals) {
    const listener = () => frame(3, JSON.stringify({ type: "signal", signal }), true);
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  const resize = () => {
    for (const [fd, stream] of [process.stdin, process.stdout, process.stderr].entries()) {
      const key = ["stdin", "stdout", "stderr"][fd];
      if (!terminals[key]) continue;
      const next = size(stream);
      if (JSON.stringify(next) !== JSON.stringify(terminals[key])) {
        terminals[key] = next;
        frame(3, JSON.stringify({ type: "resize", fd, ...next }), true);
      }
    }
  };
  listeners.set("SIGWINCH", resize);
  process.on("SIGWINCH", resize);
  if (terminals.stdin) process.stdin.setRawMode(true);
  process.stdin.on("data", bytes => { if (!frame(0, bytes, false)) process.stdin.pause(); });
  process.stdin.on("end", () => frame(0, Buffer.alloc(0), true));
  socket.on("drain", () => { if (!finished) process.stdin.resume(); });
  process.stdin.resume();
});
`;

export async function materialize(options: MaterializeOptions): Promise<MaterializedTree> {
  const { bundle, contract, bindings } = options;
  const { endpoints, run } = contract;
  if (!endpoints || "resume" in run) throw new Error("This harness resumes its own session; it has no endpoints to materialize");
  const [base, candidate] = await Promise.all([readTree(options.base.directory), readTree(options.candidate.directory)]);
  if (hashTree(base) !== options.base.digest) throw new Error("Base tree digest mismatch");
  if (hashTree(candidate) !== options.candidate.digest) throw new Error("Candidate tree digest mismatch");
  for (const [path, entry] of [...base, ...candidate]) if (entry.link) throw new Error(`Cannot materialize a harness symlink: ${path}`);
  const editable = (path: string) => contract.editable.some(pattern => matchesGlob(path, pattern));
  for (const path of new Set([...base.keys(), ...candidate.keys()])) {
    const before = base.get(path), after = candidate.get(path);
    if (before && after && before.mode === after.mode && (before.bytes === undefined ? after.bytes === undefined : after.bytes !== undefined && before.bytes.equals(after.bytes))) continue;
    if (editable(path)) continue;
    const structural = (!before || !after) && (before ?? after)!.bytes === undefined;
    const descendants = [...base, ...candidate].filter(([p, e]) => p.startsWith(path + "/") && e.bytes !== undefined);
    if (structural && (editable(path + "/") || descendants.length > 0 && descendants.every(([p]) => editable(p)))) continue;
    throw new Error(`Candidate changed a noneditable path: ${path}`);
  }

  const tree: Tree = new Map();
  const omitted = new Set<string>();
  let originalCwd: string | undefined;
  if (bundle.manifest.workdir) {
    if (!bundle.manifest.workdir.startsWith("data/workdir/")) throw new Error("Snapshot manifest is outside data/workdir/");
    const snapshot = validate("workdir", JSON.parse(lockedFile(bundle, bundle.manifest.workdir).toString("utf8")));
    if (!snapshot.ok) throw new Error(`Invalid workdir snapshot: ${snapshot.errors.join("; ")}`);
    originalCwd = snapshot.value.path;
    for (const path of snapshot.value.unread) { pathInside("/worktree", path); omitted.add(path); }
    const seen = new Set<string>();
    for (const entry of snapshot.value.entries) {
      pathInside("/worktree", entry.path);
      if (seen.has(entry.path)) throw new Error(`Duplicate snapshot path: ${entry.path}`);
      seen.add(entry.path);
      if (entry.state === "ignored" || entry.state === "ignored-copied" && (!snapshot.value.ignored_copied || bundle.manifest.include_ignored !== true)) {
        omitted.add(entry.path);
        continue;
      }
      if (omitted.has(entry.path)) continue;
      const mode = parseInt(entry.mode!, 8);
      if (mode > 0o177777 || (mode & 0o170000) !== 0 && (mode & 0o170000) !== 0o100000) throw new Error(`Snapshot contains a nonregular file: ${entry.path}`);
      tree.set(entry.path, { mode: mode & 0o7777, bytes: blob(bundle, entry.blob!) });
    }
  } else if (bundle.manifest.source !== "scenario") throw new Error("Snapshot moment has no workdir manifest");

  for (const path of new Set([...base.keys(), ...candidate.keys()])) {
    if ([...omitted].some(p => path === p || path.startsWith(p + "/"))) continue;
    if (tree.has(path) && !editable(path)) continue;
    const entry = candidate.get(path);
    if (entry) tree.set(path, entry);
    else if (editable(path)) tree.delete(path);
  }
  for (const path of [...tree.keys()]) {
    let parent = dirname(path);
    while (parent !== ".") {
      const entry = tree.get(parent);
      if (entry?.bytes !== undefined) throw new Error(`File/directory collision while materializing: ${parent}`);
      if (!entry) tree.set(parent, { mode: 0o755 });
      parent = dirname(parent);
    }
  }

  const attempt = resolve(options.directory);
  for (const source of [options.base.directory, options.candidate.directory, bundle.root]) {
    const root = await realpath(source);
    const rel = relative(root, attempt);
    if (!rel || rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)) throw new Error("Attempt directory overlaps an immutable input");
  }
  await mkdir(attempt, { recursive: true, mode: 0o700 });
  if ((await lstat(attempt)).isSymbolicLink() || await realpath(attempt) !== attempt) throw new Error("Attempt directory must not contain symlinks");
  const directory = join(attempt, "worktree"), support = join(attempt, "support");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(support, { mode: 0o700 });
  for (const [path, entry] of [...tree].sort(([a], [b]) => a.length - b.length)) {
    const target = pathInside(directory, path);
    if (entry.bytes === undefined) await mkdir(target, { mode: 0o700 });
    else await writeFile(target, entry.bytes, { flag: "wx", mode: 0o600 });
  }

  const routes: MaterializedTree["routes"] = { mcp: Object.create(null), mcpHttp: Object.create(null), http: Object.create(null), cli: Object.create(null) };
  const env: Record<string, string> = { ...options.env, [endpoints.model.env]: options.llm };
  const replayPath = `/phoenix/bin:${env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`;
  const hostFor = (surface: string, connector: string) => `${surface}-${/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(connector) ? connector : digest(connector).slice(7, 47)}`;
  const mcp: Record<string, unknown> = Object.create(null);
  let config: Record<string, unknown> | undefined;
  let mcpPath: string | undefined;
  if (endpoints.mcp) {
    if (endpoints.mcp.format !== "mcpServers") throw new Error(`Unsupported MCP config format: ${endpoints.mcp.format}`);
    mcpPath = pathInside(directory, endpoints.mcp.file);
    const entry = tree.get(endpoints.mcp.file);
    if (entry?.bytes) config = JSON.parse(entry.bytes.toString("utf8")) as Record<string, unknown>;
    else config = {};
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("MCP config is not an object");
  }
  const cli: Record<string, unknown> = Object.create(null);
  for (const [connector, info] of Object.entries(bundle.manifest.connectors ?? {})) {
    const binding = bindings?.connectors[connector];
    if (info.surface === "mcp") {
      if (!config) throw new Error(`No MCP config endpoint for connector: ${connector}`);
      const name = binding?.mcp_server ?? connector;
      if (Object.hasOwn(mcp, name)) throw new Error(`Two connectors bind the same MCP entry: ${name}`);
      const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
      const settings = servers?.[name];
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`Missing MCP config entry: ${name}`);
      if (binding?.serve === "real") {
        if (typeof settings.command !== "string" || typeof settings.url === "string") throw new Error(`Cannot run a real remote MCP server: ${connector}`);
        mcp[name] = settings;
        continue;
      }
      if (typeof settings.url === "string") {
        const path = `/mcp/${encodeURIComponent(connector)}`;
        routes.mcpHttp[path] = connector;
        mcp[name] = { ...(typeof settings.type === "string" ? { type: settings.type } : {}), url: `http://phoenix-tools:8080${path}` };
      } else if (typeof settings.command === "string") {
        const host = hostFor("mcp", connector);
        if (routes.mcp[host]) throw new Error(`Duplicate MCP relay host: ${host}`);
        routes.mcp[host] = connector;
        mcp[name] = { command: "node", args: ["/phoenix/mcp.mjs", host] };
      } else throw new Error(`MCP entry has no command or URL: ${name}`);
    } else {
      if (info.surface === "cli" && binding?.serve === "real") continue;
      const evidence = events(bundle, connector);
      if (info.surface === "cli") {
        const command = binding?.command ?? connector;
        pathInside("/phoenix/bin", command);
        if (command.includes("/")) throw new Error(`CLI binding must be a command name: ${command}`);
        if (Object.hasOwn(cli, command)) throw new Error(`Two connectors bind the same CLI command: ${command}`);
        const invocation = cliInvocation(bundle, evidence, connector);
        for (const [key, value] of Object.entries(invocation.env)) if (key !== "PATH" && key !== endpoints.model.env && env[key] === undefined) env[key] = value;
        const host = hostFor("cli", connector);
        if (routes.cli[host]) throw new Error(`Duplicate CLI relay host: ${host}`);
        routes.cli[host] = connector;
        cli[command] = { host, argv0: invocation.argv[0], cwd: /^(.*\/runtime\/capture-[^/]+\/cwd)(?:\/|$)/.exec(invocation.cwd)?.[1] ?? originalCwd ?? invocation.cwd, env: invocation.env, path: replayPath };
      } else {
        for (const event of evidence) {
          if (event.kind !== "meta" || !event.body) continue;
          const bytes = "inline" in event.body ? Buffer.from(event.body.inline) : blob(bundle, event.body.blob);
          const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
          const meta = (value.meta ?? value) as Record<string, unknown>;
          const head = (meta.request ?? meta) as { url?: string; method?: string; authority?: string; headers?: string[] };
          if (typeof head.url !== "string" || typeof head.method !== "string") continue;
          let host = head.authority;
          for (let i = 0; i + 1 < (head.headers?.length ?? 0); i += 2)
            if (!host && head.headers![i]!.toLowerCase() === "host") host = head.headers![i + 1];
          if (/^[a-z]+:\/\//i.test(head.url)) host = new URL(head.url).host;
          host = (host ?? "").replace(/:(80|443)$/, "").toLowerCase();
          if (!host) continue;
          if (routes.http[host] && routes.http[host] !== connector) throw new Error(`Two connectors bind the same HTTP host: ${host}`);
          routes.http[host] = connector;
        }
      }
    }
  }
  if (mcpPath && config) {
    await mkdir(dirname(mcpPath), { recursive: true, mode: 0o700 });
    await writeFile(mcpPath, JSON.stringify({ ...config, mcpServers: mcp }, null, 2) + "\n", { mode: 0o600 });
  }
  await writeFile(join(support, "task.txt"), bundle.manifest.prompt ?? "", { flag: "wx", mode: 0o600 });
  await writeFile(join(support, "mcp.mjs"), mcpShim, { flag: "wx", mode: 0o600 });
  if (Object.keys(cli).length) {
    await mkdir(join(support, "bin"), { mode: 0o700 });
    await writeFile(join(support, "cli.json"), JSON.stringify(cli), { flag: "wx", mode: 0o600 });
    for (const command of Object.keys(cli)) await writeFile(join(support, "bin", command), cliShim, { flag: "wx", mode: 0o755 });
    env.PATH = replayPath;
  }
  for (const [path, entry] of [...tree].sort(([a], [b]) => b.length - a.length)) await chmod(pathInside(directory, path), entry.mode);
  let argv = ("command" in run ? run.command : run.serve).map(arg => arg.replaceAll("{task_file}", "/phoenix/task.txt"));
  if (run.build) {
    const launcher = `import { spawn } from "node:child_process";
let child;
const listeners = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGCONT", "SIGWINCH"]) {
  const listener = () => child?.kill(signal);
  listeners.set(signal, listener);
  process.on(signal, listener);
}
const run = argv => new Promise((resolve, reject) => {
  child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
let result;
try {
  result = await run(${JSON.stringify(run.build.map(arg => arg.replaceAll("{task_file}", "/phoenix/task.txt")))});
  if (result.code === 0 && !result.signal) result = await run(${JSON.stringify(argv)});
} catch (error) {
  process.stderr.write(error.message + "\\n");
  result = { code: 1, signal: null };
}
for (const [signal, listener] of listeners) process.off(signal, listener);
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.code ?? 1;
`;
    await writeFile(join(support, "launch.mjs"), launcher, { flag: "wx", mode: 0o600 });
    argv = ["node", "/phoenix/launch.mjs"];
  }
  return { directory, support, argv, env, routes };
}
