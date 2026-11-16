import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse } from "yaml";
import type { Bindings, HarnessContract, PluginDescriptor, RecipeDescriptor, ReplayPlan } from "@phoenix/formats";
import { createSimulator, resolveModelDialect, type SimulatorOptions } from "@phoenix/engine";
import { bundleApproval, digest, readApprovalsLedger, readMomentBundle } from "@phoenix/store";
import { bundleEvidence, canonical, checked, echoDriftPath, eventId, hydrate, optional, save } from "./files.ts";
import { treeDigest, type TreeInput } from "./materialize.ts";

export interface ReplayRequest {
  moment: string;
  base: TreeInput;
  candidate: TreeInput;
  harness: HarnessContract;
  bindings?: Bindings;
  image: string;
  model?: ReplayPlan["model"] & { connector: string; url: string; headers?: Record<string, { env: string }> };
  recipe?: string;
  start: ReplayPlan["start"];
  samples?: ReplayPlan["samples"];
  runtime?: { cli: string[]; version: string };
  clockProbe?: string[];
  loginContext?: NonNullable<ReplayPlan["login_context"]>;
  env?: Record<string, string>;
  plugins?: { name: string; version: string; directory: string; image: string; snapshot?: string; seed?: string; env?: Record<string, string> }[];
  simulator?: { model: Pick<ReplayPlan["model"], "id" | "alias">; config: Omit<SimulatorOptions["provider"]["configuration"], "model"> & { attempts?: number; outputSchemas?: SimulatorOptions["outputSchemas"] }; improverModel: string; headers?: Record<string, { env: string }> };
}

export interface ResolvedPlugin {
  name: string; version: string; tree: string; image: string; descriptor: PluginDescriptor; snapshot?: string; seed?: string; env?: Record<string, string>;
}

export interface ResolvedRecipe { name: string; file: string; tree: string; resume: NonNullable<RecipeDescriptor["resume"]> }

export type ResolvedPlan = ReplayPlan & {
  runner: { harness: HarnessContract; bindings?: Bindings; model?: ReplayRequest["model"]; recipe?: ResolvedRecipe; env: Record<string, string>; cli: string[]; plugins: ResolvedPlugin[]; simulator?: ReplayRequest["simulator"] };
};

export async function resolvePlan(root: string, ledger: string, request: ReplayRequest): Promise<{ id: string; plan: ResolvedPlan }> {
  const bundle = await readMomentBundle(request.moment);
  bundleApproval(bundle, (await readApprovalsLedger(ledger)).entries);
  checked("harness", request.harness);
  const resume = bundle.manifest.resume;
  let recipe: ResolvedRecipe | undefined;
  if (resume) {
    if (!("resume" in request.harness.run)) throw new Error("This moment resumes its own session; the harness contract must say run: { resume: {} }");
    if (!request.recipe) throw new Error(`This moment resumes its own session; the replay settings must name the ${resume.recipe} recipe`);
    const descriptor = checked("recipe", parse(await readFile(request.recipe, "utf8"))) as RecipeDescriptor;
    if (descriptor.name !== resume.recipe || !descriptor.resume) throw new Error(`The ${resume.recipe} moment needs the ${resume.recipe} recipe with a resume section`);
    recipe = { name: descriptor.name, file: basename(request.recipe), tree: await treeDigest(dirname(request.recipe)), resume: descriptor.resume };
  } else {
    const dialect = request.harness.endpoints?.model.dialect;
    if (!dialect || !resolveModelDialect(dialect)) throw new Error(`Unsupported model dialect: ${dialect}`);
    if (!request.model) throw new Error("The replay settings name no model");
  }
  if (request.bindings) checked("bindings", request.bindings);
  for (const tree of [request.base, request.candidate]) if (await treeDigest(tree.directory) !== tree.digest) throw new Error(`Tree digest mismatch: ${tree.digest}`);
  if (request.start === "echo" && request.base.digest !== request.candidate.digest) throw new Error("Echo replays require the unedited base tree");
  if (bundle.manifest.harness && bundle.manifest.harness.tree !== request.base.digest) throw new Error("Base tree does not match the locked harness");
  const events = hydrate(bundleEvidence(bundle), bundle.files);
  if (request.start !== "beginning" && request.start !== "echo") {
    const mark = events.findIndex(e => eventId(e) === bundle.manifest.mark);
    const at = request.start === "mark" ? mark : events.findIndex(e => eventId(e) === request.start.at);
    if (mark < 0 || at < 0 || at > mark) throw new Error("Start must be a cut between the beginning and the mark");
    const echo = await optional<{ result: string }>(echoDriftPath(root, request.base.digest, request.loginContext));
    if (echo) throw new Error(`This base tree supports only beginning; echo drift: ${echo.result}`);
  }
  if (!events.length && request.start !== "beginning") throw new Error("A scenario with no staged run starts only at beginning");
  for (const rule of request.loginContext ?? []) {
    try { new RegExp(rule.pattern); } catch { throw new Error(`Login context pattern is not a regular expression: ${rule.name}`); }
  }
  const modelUrl = request.model && new URL(request.model.url);
  if (modelUrl && (modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash || !["http:", "https:"].includes(modelUrl.protocol))) throw new Error("Model URL must not carry credentials or query parameters");
  for (const ref of [...Object.values(request.model?.headers ?? {}), ...Object.values(request.simulator?.headers ?? {})]) if (!ref || Object.keys(ref).length !== 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env)) throw new Error("Model credentials must be host environment references");
  if (request.simulator) createSimulator({ moment: bundle.lockHash, root: join(root, "simulator"), configuration: { ...request.simulator.config, model: request.simulator.model.id }, headers: {}, improverModel: request.simulator.improverModel, attempts: request.simulator.config.attempts, outputSchemas: request.simulator.config.outputSchemas });
  const plugins: ResolvedPlugin[] = [];
  for (const plugin of request.plugins ?? []) {
    if (plugins.some(p => p.name === plugin.name)) throw new Error(`Duplicate plugin: ${plugin.name}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(plugin.image)) throw new Error("Plugin image must be digest-pinned");
    const descriptor = checked("plugin", JSON.parse(await readFile(join(plugin.directory, "phoenix-plugin.json"), "utf8")));
    if (!plugin.name || !plugin.version || /[~^*<>=| ]/.test(plugin.version)) throw new Error("Plugin versions must be resolved, not ranges");
    if (!descriptor.recognize.commands?.length && ![descriptor.connector, ...descriptor.recognize.mcp_servers ?? []].some(name => bundle.manifest.connectors?.[name])) throw new Error(`Plugin connector is not in this moment: ${descriptor.connector}`);
    for (const path of [plugin.snapshot, plugin.seed]) if (path && !bundle.files.has(path)) throw new Error(`Plugin input is not locked bundle data: ${path}`);
    const home = await realpath(plugin.directory);
    const outside = (path: string) => { const inside = relative(home, path); return inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside); };
    for (const entry of await readdir(plugin.directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const link = join(entry.parentPath, entry.name), target = await readlink(link);
      let at = await realpath(entry.parentPath);
      for (const part of target.split(sep)) at = part === ".." ? dirname(at) : !part || part === "." ? at : await realpath(join(at, part)).catch(() => join(at, part));
      if (isAbsolute(target) || outside(at))
        throw new Error(`Plugin ${plugin.name} links ${relative(plugin.directory, link)} to ${target}, outside its folder. A replay mounts only the plugin folder, so the link would be broken there. Install the packed plugin instead: pack it, unpack it, and install its dependencies inside the unpacked folder.`);
    }
    const { directory: _, ...settings } = plugin;
    plugins.push({ ...settings, descriptor, tree: await treeDigest(plugin.directory) });
  }
  const plan: ResolvedPlan = {
    phoenix_plan: 1, bundle: bundle.lockHash, check: bundle.lock.check, base_tree: request.base.digest, candidate_tree: request.candidate.digest,
    harness_image: request.image, model: request.model ? { id: request.model.id, ...(request.model.alias !== undefined ? { alias: request.model.alias } : {}), ...(request.model.parameters ? { parameters: request.model.parameters } : {}) } : { id: bundle.manifest.model?.id ?? "unknown" },
    start: request.start, samples: request.samples ?? bundle.check.samples ?? { base: 2, tiebreak: 1 }, plugins: Object.fromEntries(plugins.map(p => [p.name, p.version])),
    container_runtime: request.runtime?.version ?? "docker", clock_probe: request.clockProbe ?? ["node", "-e", "console.log(Date.now())"], ...(request.loginContext?.length ? { login_context: request.loginContext } : {}), matching_rules: "2",
    ...(request.simulator ? { simulator: { model: request.simulator.model, config: request.simulator.config } } : {}),
    runner: { harness: request.harness, ...(request.bindings ? { bindings: request.bindings } : {}), ...(request.model ? { model: request.model } : {}), ...(recipe ? { recipe } : {}), env: request.env ?? {}, cli: request.runtime?.cli ?? ["docker"], plugins, ...(request.simulator ? { simulator: request.simulator } : {}) },
  };
  checked("plan", plan);
  const id = digest(canonical(plan));
  const directory = join(root, "replays", id.slice(7));
  const existing = await optional<ResolvedPlan>(join(directory, "plan.json"));
  if (existing) { if (canonical(existing) !== canonical(plan)) throw new Error("Replay identity collision"); return { id, plan: existing }; }
  await mkdir(join(root, "replays"), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, "replays/.resolve-"));
  await mkdir(join(stage, "inputs"));
  await cp(request.moment, join(stage, "inputs/bundle"), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  await cp(request.base.directory, join(stage, "inputs/base"), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  await cp(request.candidate.directory, join(stage, "inputs/candidate"), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  if (request.recipe && recipe) {
    await cp(dirname(request.recipe), join(stage, "inputs/recipe"), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    if (await treeDigest(join(stage, "inputs/recipe")) !== recipe.tree) throw new Error("Recipe changed while resolving the plan");
  }
  for (const [index, plugin] of (request.plugins ?? []).entries()) {
    await cp(plugin.directory, join(stage, "inputs/plugins", String(index)), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    if (await treeDigest(join(stage, "inputs/plugins", String(index))) !== plugins[index]!.tree) throw new Error("Plugin changed while resolving the plan");
  }
  for (const [name, hash] of [["base", plan.base_tree], ["candidate", plan.candidate_tree]] as const) if (await treeDigest(join(stage, "inputs", name)) !== hash) throw new Error("Tree changed while resolving the plan");
  await save(join(stage, "plan.json"), plan);
  await rename(stage, directory);
  return { id, plan };
}
