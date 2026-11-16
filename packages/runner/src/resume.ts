import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readsOnly, recognizeCommand, startToolStandIn, type SimulatorOptions, type ToolStandIn, type ToolStandInOptions } from "@phoenix/engine";
import { parse } from "yaml";
import type { RecipeDescriptor } from "@phoenix/formats";
import { writeClockFile, type Sandbox, type SandboxProcess } from "@phoenix/sandbox";
import type { MomentBundle } from "@phoenix/store";
import type { ResolvedPlan } from "./plan.ts";
import { optional, save } from "./files.ts";

const execute = promisify(execFile);
const TOOLS_HOST = "phoenix-tools";

interface SessionMoment {
  cut_lines: number;
  prompt: string;
  model: { provider: string; id: string; thinking?: string };
  loadout: unknown;
  box?: unknown;
  in_box?: Record<string, string[]>;
  shell?: Record<string, Record<string, { command: string; cwd?: string }>>;
  cwd?: string;
  answers: { id: string; connector: string; op: string; args: unknown; result: unknown; observed_at: string; before_cut: boolean; world?: "exact" | "any-args" }[];
}

async function fileHashes(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (entry.name !== ".git") await walk(path); }
      else if (entry.isSymbolicLink()) hashes.set(path, `link:${await readlink(join(root, path))}`);
      else if (entry.isFile()) hashes.set(path, await readFile(join(root, path)).then(bytes => createHash("sha256").update(bytes).digest("hex"), () => "unreadable"));
    }
  };
  await walk("");
  return hashes;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): { changed: string[]; added: string[]; removed: string[] } {
  return {
    changed: [...after].filter(([path, hash]) => before.has(path) && before.get(path) !== hash).map(([path]) => path).sort(),
    added: [...after.keys()].filter(path => !before.has(path)).sort(),
    removed: [...before.keys()].filter(path => !after.has(path)).sort(),
  };
}

export type Outcome = { kind: "finished"; code: number | null } | { kind: "interrupted"; why: string } | { kind: "diverged"; trigger: string; detail: string } | { kind: "not-run"; why: string };
class NotRun extends Error {}

export async function resumeAttempt(input: {
  id: string; directory: string; root: string; plan: ResolvedPlan; bundle: MomentBundle; sandbox: Sandbox; hmacKey: Uint8Array; capture: string;
  simulator?: Omit<SimulatorOptions, "clock">;
  started(container: string): Promise<void>;
}): Promise<Outcome> {
  const { directory, root, plan, bundle, sandbox } = input;
  const recipe = plan.runner.recipe!;
  const resume = bundle.manifest.resume!;
  const recipeDirectory = join(directory, "inputs/recipe");
  const moment = JSON.parse(Buffer.from(bundle.files.get(resume.moment)!).toString("utf8")) as SessionMoment;
  const session = Buffer.from(bundle.files.get(resume.session)!).toString("utf8").split("\n");
  const hosts = recipe.resume.llm_hosts[moment.model.provider];
  if (!hosts) throw new Error(`The ${recipe.name} recipe names no LLM host for provider ${moment.model.provider}`);
  const box = join(root, "box");
  for (const part of ["moment", "agent", "out"]) await mkdir(join(box, part), { recursive: true, mode: 0o700 });
  const project = resume.project;
  let copied: Map<string, string> | undefined;
  if (project) {
    await mkdir(join(box, "project"), { recursive: true, mode: 0o700 });
    for (const part of [project.tar, ...project.more ?? []]) {
      await writeFile(join(box, "project.tar"), bundle.files.get(part)!, { mode: 0o600 });
      await execute("tar", ["-xf", join(box, "project.tar"), "-C", join(box, "project")]);
      await rm(join(box, "project.tar"));
    }
    copied = await fileHashes(join(box, "project"));
  }
  await writeFile(join(box, "moment/cut.jsonl"), session.slice(0, moment.cut_lines).join("\n") + "\n", { mode: 0o600 });
  const { answers: _answers, loadout, ...reading } = moment;
  await writeFile(join(box, "moment/moment.json"), JSON.stringify(reading), { mode: 0o600 });
  await writeFile(join(box, "moment/loadout.json"), JSON.stringify(loadout), { mode: 0o600 });
  if (resume.files) for (const [path, bytes] of bundle.files) {
    if (!path.startsWith(`${resume.files}/`)) continue;
    const target = join(box, "moment/files", path.slice(resume.files.length + 1));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  }
  const names = new Set([...moment.answers.map(a => a.connector), ...Object.keys(bundle.manifest.connectors ?? {}), ...Object.keys(moment.in_box ?? {})]);
  const plugins = new Map<string, { plugin: ResolvedPlan["runner"]["plugins"][number]; index: number }>();
  for (const [index, plugin] of plan.runner.plugins.entries()) for (const name of names)
    if (!plugins.has(name) && (name === plugin.descriptor.connector || plugin.descriptor.recognize.mcp_servers?.includes(name))) plugins.set(name, { plugin, index });
  for (const [index, plugin] of plan.runner.plugins.entries())
    if (plugin.descriptor.recognize.commands?.length && !plugins.has(plugin.descriptor.connector) && ![...plugins.values()].some(p => p.index === index)) plugins.set(plugin.descriptor.connector, { plugin, index });
  const commandPlugins = [...plugins].filter(([, { plugin }]) => plugin.descriptor.serve).map(([name, { plugin }]) => ({ ...plugin.descriptor, connector: name }));
  const time = bundle.manifest.clock?.time ?? new Date().toISOString();
  const emulators: NonNullable<ToolStandInOptions["emulators"]>[number][] = [];
  for (const [name, { plugin, index }] of plugins) {
    if (!plugin.descriptor.serve) continue;
    const pluginRoot = join(root, "emulators", name);
    await mkdir(join(pluginRoot, "inputs"), { recursive: true, mode: 0o700 });
    const all = moment.answers.filter(a => a.connector === name);
    const firstWrite = all.findIndex(a => !a.before_cut && !plugin.descriptor.read_only?.includes(`tools/call:${a.op}`));
    const own = all.filter((a, at) => a.before_cut || firstWrite < 0 || at < firstWrite || (a.world && plugin.descriptor.read_only?.includes(`tools/call:${a.op}`)));
    const snapshot = own.flatMap((a, seq) => [
      { v: 1, capture: input.capture, stream: "session", seq: seq * 2, ts: { wall: a.observed_at }, kind: "call", connector: plugin.descriptor.connector, surface: "mcp", op: `tools/call:${a.op}`, body: { inline: JSON.stringify({ jsonrpc: "2.0", id: seq, method: "tools/call", params: { name: a.op, arguments: a.args } }) } },
      { v: 1, capture: input.capture, stream: "session", seq: seq * 2 + 1, ts: { wall: a.observed_at }, kind: "result", connector: plugin.descriptor.connector, surface: "mcp", op: `tools/call:${a.op}`, body: { inline: JSON.stringify({ jsonrpc: "2.0", id: seq, result: a.result }) } },
    ].map(event => JSON.stringify(event) + "\n")).join("");
    await writeFile(join(pluginRoot, "inputs/snapshot"), plugin.snapshot ? bundle.files.get(plugin.snapshot)! : snapshot, { mode: 0o600 });
    await writeFile(join(pluginRoot, "inputs/seed"), plugin.seed ? bundle.files.get(plugin.seed)! : JSON.stringify({ seed: `sha256:${createHash("sha256").update(`${input.id}:${input.capture}`).digest("hex")}` }), { mode: 0o600 });
    await writeClockFile(join(pluginRoot, "clock"), time);
    emulators.push({ plugin: { directory: join(directory, "inputs/plugins", String(index)), descriptor: { ...plugin.descriptor, connector: name } }, options: { context: { snapshot: "/inputs/snapshot", seed: "/inputs/seed" }, env: plugin.env, replay: { sandbox, spec: { image: plugin.image, mounts: [{ source: join(directory, "inputs/plugins", String(index)), target: "/plugin", readOnly: true }, { source: join(pluginRoot, "inputs"), target: "/inputs", readOnly: true }], workdir: "/plugin", clockFile: join(pluginRoot, "clock"), dontFakeMonotonic: true } } } });
  }
  const standIn: ToolStandIn = await startToolStandIn({
    emulators,
    host: TOOLS_HOST,
    answers: moment.answers.map(a => ({ id: a.id, connector: a.connector, op: a.op, args: a.args, result: a.result, observedAt: a.observed_at, beforeCut: a.before_cut, ...(a.world ? { world: a.world } : {}) })),
    inBox: (connector, op, args) => {
      if (!project) return false;
      if ((moment.in_box?.[connector] ?? []).includes(op)) return true;
      const shell = moment.shell?.[connector]?.[op];
      const given = args as Record<string, unknown>;
      const command = shell && given[shell.command], cwd = (shell?.cwd ? given[shell.cwd] : undefined) ?? moment.cwd;
      return typeof command === "string" && readsOnly(command, project.root, typeof cwd === "string" ? cwd : undefined, join(box, "project"));
    },
    pluginCommand: (connector, op, args) => {
      const shell = moment.shell?.[connector]?.[op];
      const given = args as Record<string, unknown>;
      const command = shell && given[shell.command], givenCwd = (shell?.cwd ? given[shell.cwd] : undefined) ?? moment.cwd;
      const found = typeof command === "string" ? recognizeCommand(command, commandPlugins, project?.home) : undefined;
      if (!found || found.calls.some(c => c.conditional)) return undefined;
      const cwd = typeof givenCwd === "string" ? givenCwd : undefined;
      const rest = found.around.replace(/\u0000\d+\u0000/g, "true");
      const guarded = project ? readsOnly(rest, project.root, cwd, join(box, "project")) : /^true(?: [12]>& '[12]'| (?:[12]?>>?|&>) '\/dev\/null')*$/.test(rest);
      return guarded ? { calls: found.calls.map(c => ({ connector: c.connector, argv: c.argv, env: c.env ?? {}, cwd: cwd ?? project?.root ?? "/", ...(c.stdin === undefined ? {} : { stdin: c.stdin }) })), around: found.around } : undefined;
    },
    ...(input.simulator ? { simulator: input.simulator } : {}),
    cutTime: bundle.manifest.clock?.time ?? new Date().toISOString(),
    policy: connector => {
      const plugin = plugins.get(connector)?.plugin.descriptor;
      return { ...bundle.manifest.connectors?.[connector], ...(plugin ? { entity_map: plugin.entity_map, read_only: (plugin.read_only ?? []).map(op => ({ op, source: "plugin" as const })), volatile: plugin.volatile ?? [] } : {}) };
    },
    sample: { root: join(root, "trace"), metadata: { capture: input.capture, harness: { name: plan.runner.harness.name, tree: plan.candidate_tree }, recipe: { name: recipe.name, version: "1" }, routes: ["tap"], started_at: new Date().toISOString(), boot_id: input.capture } },
    hmacKey: input.hmacKey,
  });
  let process: SandboxProcess | undefined;
  let outcome: Outcome;
  try {
    const [login, ...loginArgs] = recipe.resume.login;
    await execute(login!, [...loginArgs, join(box, "agent"), moment.model.provider], { cwd: recipeDirectory }).catch((error: { stderr?: string; message: string }) => {
      const said = (error.stderr || error.message).trim();
      throw new NotRun(said.match(/^Error: (.+)$/m)?.[1] ?? said);
    });
    await writeClockFile(join(root, "clock"), time);
    const { clock } = parse(await readFile(join(recipeDirectory, recipe.file), "utf8")) as RecipeDescriptor;
    const running = await sandbox.start({
      image: plan.harness_image, argv: recipe.resume.command, env: { PHOENIX_TOOLS_URL: `http://${TOOLS_HOST}`, TZ: bundle.manifest.clock?.timezone ?? "UTC", ...(project ? { PHOENIX_PROJECT: project.root } : {}) },
      mounts: [
        { source: recipeDirectory, target: "/phoenix/recipe", readOnly: true },
        { source: join(box, "moment"), target: "/phoenix/moment", readOnly: true },
        { source: join(box, "agent"), target: "/phoenix/agent" },
        { source: join(box, "out"), target: "/phoenix/out" },
        { source: join(directory, "inputs/candidate"), target: "/worktree", readOnly: true },
        ...(project ? [{ source: join(box, "project"), target: project.root }] : []),
      ],
      clockFile: join(root, "clock"), virtualTime: time, ...(clock ? { clockProbe: clock.probe } : {}), workdir: "/worktree", dontFakeMonotonic: true, directHosts: hosts,
    });
    process = running.process;
    await save(join(root, "clock-report.json"), process.clock);
    await input.started(process.id);
    process.stdin.end();
    process.stdout.resume();
    let stderr = "";
    process.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    const connections = (async () => { for await (const connection of running.channel) standIn.accept(connection); })().then(() => ({ kind: "interrupted" as const, why: "engine channel closed" }), () => ({ kind: "interrupted" as const, why: "engine channel closed" }));
    outcome = await Promise.race([
      process.exited.then(({ code }) => ({ kind: "finished" as const, code })),
      process.interrupted.then(error => ({ kind: "interrupted" as const, why: error.message })),
      standIn.stopped.then(divergence => ({ kind: "diverged" as const, trigger: divergence.trigger, detail: divergence.detail })),
      connections,
    ]);
    const egress = await process.egress?.();
    await standIn.note("sandbox.egress", { llm_hosts: hosts, direct_rules: egress?.stdout ?? null, tool_answers_from_phoenix: standIn.served() });
    const result = await optional<{ session: string | null; final_text: string }>(join(box, "out/result.json"));
    if (stderr) await standIn.note("harness.stderr", stderr);
    if (project && copied) await standIn.note("files.copy", { root: project.root, source: project.source, ...(project.commit ? { commit: project.commit } : {}), taken_at: project.taken_at, ...changedFiles(copied, await fileHashes(join(box, "project"))) });
    if (result?.final_text) await standIn.note("final_text", result.final_text);
    if (result?.session) {
      const entries = (await readFile(join(box, "out", result.session), "utf8")).split("\n").filter(Boolean);
      await standIn.note("session.resumed", entries.slice(moment.cut_lines).map(line => JSON.parse(line)));
    }
  } catch (error) { outcome = error instanceof NotRun ? { kind: "not-run", why: error.message } : { kind: "interrupted", why: error instanceof Error ? error.message : String(error) }; }
  finally {
    await process?.stop().catch(() => {});
    await rm(join(box, "agent"), { recursive: true, force: true });
    await rm(join(box, "project"), { recursive: true, force: true });
    await standIn.close();
  }
  return outcome;
}
