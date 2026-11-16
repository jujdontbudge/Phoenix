import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createSimulator, EmulatorStartError, resolveModelDialect, startEngine, type Engine, type EngineOptions } from "@phoenix/engine";
import { ContainerSandbox, writeClockFile, type ClockReport, type Sandbox, type SandboxProcess } from "@phoenix/sandbox";
import { compareBaseline, customCheckHost, evaluateCheck, momentVerdict, sampleVerdict } from "@phoenix/checks";
import { fidelityReport, weakestTier, type FidelityContext, type FidelityReport } from "@phoenix/fidelity";
import { BlobStore, bundleApproval, createTraceWriter, digest, readApprovalsLedger, readCapture, readMomentBundle, type MomentBundle } from "@phoenix/store";
import type { ReplayResult, TraceEvent } from "@phoenix/formats";
import { bundleBody, bundleEvidence, canonical, checked, claim, echoDriftPath, eventId, load, optional, save } from "./files.ts";
import { materialize, treeDigest } from "./materialize.ts";
import { resolvePlan, type ReplayRequest, type ResolvedPlan } from "./plan.ts";
import { submitTask } from "./server.ts";
import { resumeAttempt, type Outcome } from "./resume.ts";

type Sample = ReplayResult["samples"][number];
type Attempt = Sample["attempts"][number] & { container?: string; recovered?: boolean; fresh_after_drift?: boolean };
type SampleState = Omit<Sample, "attempts"> & { attempts: Attempt[]; complete: boolean };
export interface ReplayStatus {
  id: string;
  state: "pending" | "running" | "interrupted" | "finished";
  samples: SampleState[];
  result?: ReplayResult;
  error?: string;
}

export interface RunnerOptions {
  root: string;
  ledger: string;
  concurrency?: number;
  sandbox?: Sandbox;
}

const execute = promisify(execFile);
function modelHeaders(refs: NonNullable<ReplayRequest["model"]>["headers"]): Record<string, string> {
  return Object.fromEntries(Object.entries(refs ?? {}).map(([name, ref]) => {
    const value = process.env[ref.env];
    if (!value) throw new Error(`Missing host model environment variable: ${ref.env}`);
    return [name, value];
  }));
}
async function sampleTrace(root: string): Promise<{ events: TraceEvent[]; body(event: TraceEvent): Promise<Uint8Array>; blobs: Record<string, string> }> {
  const blobs = new BlobStore(root);
  const body = async (event: TraceEvent): Promise<Uint8Array> => !event.body ? new Uint8Array() : "inline" in event.body ? Buffer.from(event.body.inline) : blobs.get(event.body.blob);
  try {
    const view = await readCapture(root);
    const values: Record<string, string> = {};
    for (const event of view.allEvents) if (event.body && "blob" in event.body) values[event.body.blob] = Buffer.from(await body(event)).toString("utf8");
    return { events: [...view.allEvents], body, blobs: values };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], body, blobs: {} }; throw error; }
}

function answerSources(trace: readonly TraceEvent[]): NonNullable<Sample["answers"]> {
  const results = trace.filter(e => e.kind === "result" && e.stream.startsWith("stand-in") && e.layer !== "under");
  const madeUp = results.filter(e => e.provenance === "synthesized");
  const afterUntaken = results.filter(e => e.after_untaken_write);
  return {
    session: results.filter(e => e.resolver === "recorded").length,
    files_copy: results.filter(e => e.resolver === "files-copy").length,
    working_copy: results.filter(e => e.resolver === "overlay" || e.resolver === "emulator").length,
    made_up: madeUp.length,
    made_up_calls: madeUp.map(e => ({ connector: e.connector ?? "", op: e.op ?? "" })),
    ...(afterUntaken.length ? { after_untaken_write_calls: afterUntaken.map(e => ({ connector: e.connector ?? "", op: e.op ?? "" })) } : {}),
  };
}

export class Runner {
  readonly #options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.#options = options;
    if (!Number.isInteger(options.concurrency ?? 2) || (options.concurrency ?? 2) < 1) throw new Error("Invalid runner concurrency");
  }

  directory(id: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Replay id");
    return join(this.#options.root, "replays", id.slice(7));
  }

  async plan(request: ReplayRequest): Promise<string> {
    const release = await claim(join(this.#options.root, "resolve.lock"));
    try { return (await resolvePlan(this.#options.root, this.#options.ledger, request)).id; }
    finally { await release(); }
  }

  async replay(request: ReplayRequest): Promise<string> {
    const id = await this.plan(request);
    await this.resume(id);
    return id;
  }

  async status(id: string): Promise<ReplayStatus> {
    const directory = this.directory(id);
    const plan = await load<ResolvedPlan>(join(directory, "plan.json"));
    if (digest(canonical(plan)) !== id) throw new Error("Plan hash mismatch");
    return await optional<ReplayStatus>(join(directory, "journal.json")) ?? { id, state: "pending", samples: [] };
  }

  async judge(id: string, sample: number, intent: { met: boolean; reason: string }): Promise<void> {
    const directory = this.directory(id);
    const release = await claim(join(directory, "run.lock"));
    try {
      const status = await this.status(id);
      const state = status.samples.find(s => s.sample === sample);
      const attempt = state?.attempts.at(-1);
      if (!state?.complete || !attempt) throw new Error(`Sample ${sample} has not finished`);
      const root = join(directory, "samples", String(sample), String(attempt.attempt));
      const assessment = await load<Awaited<ReturnType<typeof evaluateCheck>>>(join(root, "assessment.json"));
      const outcome = await load<{ kind: string; code?: number | null }>(join(root, "outcome.json"));
      if (outcome.kind === "not-run") throw new Error(`Sample ${sample} could not run, so it has no intent to judge`);
      if (!assessment.intentRequired) throw new Error("This check has no intent to judge");
      Object.assign(state, sampleVerdict({ ...assessment, intent, diverged: outcome.kind === "diverged" }), { intent });
      if (outcome.kind === "finished" && outcome.code !== 0) state.status = "fail";
      status.state = "pending";
      await save(join(directory, "journal.json"), status);
    } finally { await release(); }
  }

  async resume(id: string): Promise<ReplayResult> {
    const directory = this.directory(id);
    const release = await claim(join(directory, "run.lock"));
    try {
      const status = await this.status(id);
      if (status.state === "finished" && status.result) return status.result;
      const plan = checked("plan", await load<ResolvedPlan>(join(directory, "plan.json"))) as ResolvedPlan;
      const bundle = await readMomentBundle(join(directory, "inputs/bundle"));
      if (bundle.lockHash !== plan.bundle || bundle.lock.check !== plan.check) throw new Error("Resolved bundle changed");
      const approval = bundleApproval(bundle, (await readApprovalsLedger(this.#options.ledger)).entries);
      for (const [name, hash] of [["base", plan.base_tree], ["candidate", plan.candidate_tree]] as const) if (await treeDigest(join(directory, "inputs", name)) !== hash) throw new Error("Resolved tree changed");
      for (const [index, plugin] of plan.runner.plugins.entries()) if (await treeDigest(join(directory, "inputs/plugins", String(index))) !== plugin.tree) throw new Error(`Resolved plugin changed: ${plugin.name}`);
      const plugins = plan.runner.plugins.map((plugin, index) => ({ name: plugin.name, version: plugin.version, directory: join(directory, "inputs/plugins", String(index)), image: plugin.image, snapshot: plugin.snapshot, seed: plugin.seed, env: plugin.env }));
      if (plan.start !== "echo" && !plan.runner.recipe && bundleEvidence(bundle).length) {
        const echoId = await this.plan({ moment: join(directory, "inputs/bundle"), base: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, candidate: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, harness: plan.runner.harness, bindings: plan.runner.bindings, image: plan.harness_image, model: plan.runner.model, start: "echo", samples: plan.samples, runtime: { cli: plan.runner.cli, version: plan.container_runtime }, clockProbe: plan.clock_probe, ...(plan.login_context ? { loginContext: plan.login_context } : {}), env: plan.runner.env, plugins, simulator: plan.runner.simulator });
        await this.resume(echoId);
        const drift = await optional<{ result: string }>(echoDriftPath(this.#options.root, plan.base_tree, plan.login_context));
        if (plan.start !== "beginning" && drift) throw new Error(`This base tree supports only beginning; echo drift: ${drift.result}`);
      }
      let baseline: ReplayResult | undefined;
      if (plan.candidate_tree !== plan.base_tree && plan.start !== "echo") {
        const baselinePlan = { ...plan, candidate_tree: plan.base_tree };
        const baselineId = digest(canonical(baselinePlan));
        const baselineDirectory = this.directory(baselineId);
        if (!await optional(join(baselineDirectory, "plan.json"))) {
          const request: ReplayRequest = { ...(plan.runner.recipe ? { recipe: join(directory, "inputs/recipe", plan.runner.recipe.file) } : {}), moment: join(directory, "inputs/bundle"), base: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, candidate: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, harness: plan.runner.harness, bindings: plan.runner.bindings, image: plan.harness_image, model: plan.runner.model, start: plan.start, samples: plan.samples, runtime: { cli: plan.runner.cli, version: plan.container_runtime }, clockProbe: plan.clock_probe, ...(plan.login_context ? { loginContext: plan.login_context } : {}), env: plan.runner.env, plugins, simulator: plan.runner.simulator };
          const resolved = await this.plan(request);
          if (resolved !== baselineId) throw new Error("Baseline plan differs");
        }
        baseline = await this.resume(baselineId);
      }
      status.state = "running";
      delete status.error;
      let journalWrites = Promise.resolve();
      const persist = () => journalWrites = journalWrites.then(() => save(join(directory, "journal.json"), status));
      await persist();
      const evidence = bundleEvidence(bundle);
      const run = plan.runner.harness.run;
      const serverPort = "serve" in run ? Number(new URL(run.ready.http.split(" ").slice(1).join(" "), "http://localhost").port || 80) : undefined;
      const sandbox = this.#options.sandbox ?? new ContainerSandbox({ cli: plan.runner.cli, relayPorts: [80, 443, 8080].filter(port => port !== serverPort) });
      const keyPath = join(directory, "hmac.key");
      try { await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const hmacKey = await readFile(keyPath);
      const schedule = async (count: number, tiebreak: boolean): Promise<void> => {
        const first = tiebreak ? plan.samples.base : 0;
        for (let i = first; i < first + count; i++) if (!status.samples.some(s => s.sample === i)) status.samples.push({ sample: i, tiebreak, status: "unassessed", expectations: [], attempts: [], complete: false });
        await persist();
        const todo = status.samples.filter(s => s.tiebreak === tiebreak && !s.complete);
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(todo.length, this.#options.concurrency ?? 2) }, async () => {
          for (;;) {
            const sample = todo[cursor++];
            if (!sample) return;
            await this.#sample({ id, directory, plan, bundle, evidence, sample, sandbox, hmacKey, persist });
          }
        }));
      };
      await schedule(plan.samples.base, false);
      if (momentVerdict(status.samples, plan.samples).needsTiebreak) await schedule(plan.samples.tiebreak, true);
      const verdict = momentVerdict(status.samples, plan.samples);
      const reports: FidelityReport[] = [];
      const edits = new Set<string>();
      for (const sample of status.samples) {
        const attempt = sample.attempts.at(-1);
        if (!attempt) continue;
        const attemptRoot = join(directory, "samples", String(sample.sample), String(attempt.attempt));
        const report = await optional<FidelityReport>(join(attemptRoot, "fidelity.json"));
        if (report) { reports.push(report); for (const edit of report.context?.prefix_edits ?? []) edits.add(edit.field); }
      }
      const grades = reports.flatMap(r => r.grade ? [r.grade] : []);
      const result: ReplayResult = {
        phoenix_result: 1, plan: id, check: plan.check, ledger_entry: approval, start: plan.start, prefix_edits: [...edits].sort().map(field => ({ field })),
        samples: status.samples.map(({ complete: _, ...sample }) => sample), tiebreak_ran: status.samples.some(s => s.tiebreak),
        leaned_on_made_up: status.samples.some(s => s.status !== "unassessed" && s.leaned_on_made_up),
        ...(bundle.manifest.resume?.project ? { files_copy: { source: bundle.manifest.resume.project.source, ...(bundle.manifest.resume.project.commit ? { commit: bundle.manifest.resume.project.commit } : {}), taken_at: bundle.manifest.resume.project.taken_at, left_out: bundle.manifest.resume.project.left_out?.length ?? 0 } } : {}),
        verdict: verdict.verdict, discount: verdict.discount, ...(verdict.meets_check !== undefined ? { meets_check: verdict.meets_check } : {}),
        ...(grades.length ? { fidelity_grade: weakestTier(...grades) } : {}),
      };
      if (baseline) {
        const compared = compareBaseline(verdict, momentVerdict(baseline.samples, plan.samples));
        result.baseline = momentVerdict(baseline.samples, plan.samples).counts;
        if (compared.improved !== undefined) result.improved = compared.improved;
        await save(join(directory, "comparison.json"), compared);
      } else if (plan.start !== "echo") {
        result.baseline = verdict.counts;
        if (verdict.verdict !== "incomplete") result.improved = false;
        await save(join(directory, "comparison.json"), compareBaseline(verdict, verdict));
      }
      checked("result", result);
      await save(join(directory, "result.json"), result);
      status.result = result;
      status.state = status.samples.some(s => !s.complete) ? "interrupted" : "finished";
      await persist();
      return result;
    } catch (error) {
      const status = await this.status(id);
      status.state = "interrupted"; status.error = error instanceof Error ? error.message : String(error);
      await save(join(directory, "journal.json"), status);
      throw error;
    } finally { await release(); }
  }

  async #sample(input: {
    id: string; directory: string; plan: ResolvedPlan; bundle: MomentBundle; evidence: TraceEvent[]; sample: SampleState;
    sandbox: Sandbox; hmacKey: Uint8Array; persist(): Promise<void>;
  }): Promise<void> {
    const { id, directory, plan, bundle, evidence, sample, sandbox, hmacKey, persist } = input;
    const previous = sample.attempts.at(-1);
    if (previous?.status === "running") {
      const previousRoot = join(directory, "samples", String(sample.sample), String(previous.attempt));
      const completed = await optional<{ kind: string; code?: number; detail?: string }>(join(previousRoot, "outcome.json"));
      const assessment = await optional<Awaited<ReturnType<typeof evaluateCheck>>>(join(previousRoot, "assessment.json"));
      if (completed && completed.kind !== "interrupted" && assessment && !(previous.recovered && completed.kind === "diverged")) {
        Object.assign(sample, sampleVerdict({ ...assessment, diverged: completed.kind === "diverged" }), { expectations: assessment.expectations, complete: true });
        if (completed.kind === "finished" && completed.code !== 0) sample.status = "fail";
        previous.status = "finished";
        if (plan.start === "echo" && completed.kind === "diverged") await save(echoDriftPath(this.#options.root, plan.base_tree, plan.login_context), { result: id, cause: completed.detail });
        await persist();
        return;
      }
      previous.status = "interrupted"; previous.cause = "runner interrupted";
      if (!this.#options.sandbox) {
        const command = (args: string[]) => execute(plan.runner.cli[0]!, [...plan.runner.cli.slice(1), ...args]);
        const containers = new Set(previous.container ? [previous.container] : []);
        try {
          const ids = (await command(["ps", "-aq", "--filter", "name=phoenix-workload-"])).stdout.trim().split(/\s+/).filter(Boolean);
          if (ids.length) for (const line of (await command(["inspect", "--format", '{"name":{{json .Name}},"mounts":{{json .Mounts}}}', ...ids])).stdout.trim().split("\n")) {
            const container = JSON.parse(line) as { name: string; mounts: { Source: string }[] };
            if (container.mounts.some(m => m.Source.startsWith(previousRoot + "/"))) containers.add(container.name.replace(/^\//, ""));
          }
        } catch {}
        if (containers.size) await command(["rm", "-f", ...[...containers].flatMap(name => [name, name.replace("phoenix-workload-", "phoenix-relay-")])]).catch(() => {});
      }
      await persist();
    }
    const recovery = previous?.status === "interrupted" ? await Promise.all(sample.attempts.slice(sample.attempts.findLastIndex(attempt => attempt.fresh_after_drift) + 1).map(attempt => sampleTrace(join(directory, "samples", String(sample.sample), String(attempt.attempt), "trace")))) : [];
    const recovering = recovery.some(trace => trace.events.length);
    const attempt: Attempt = { attempt: sample.attempts.length, status: "running", ...(recovering ? { recovered: true } : {}) };
    sample.attempts.push(attempt);
    const root = join(directory, "samples", String(sample.sample), String(attempt.attempt));
    await mkdir(root, { recursive: true, mode: 0o700 });
    await persist();
    let engine: Engine | undefined;
    let process: SandboxProcess | undefined;
    let clockWrites = Promise.resolve();
    const submission = new AbortController();
    const states = new Map<string, unknown>();
    let outcome: Outcome;
    try {
      const simulation = plan.start !== "echo" && plan.runner.simulator;
      const simulator = simulation ? createSimulator({ moment: plan.bundle, root: join(this.#options.root, "simulator"), configuration: { ...simulation.config, model: simulation.model.id }, headers: modelHeaders(simulation.headers), improverModel: simulation.improverModel, attempts: simulation.config.attempts, outputSchemas: simulation.config.outputSchemas }) : undefined;
      if (plan.runner.recipe) {
        outcome = await resumeAttempt({ id, directory, root, plan, bundle, sandbox, hmacKey, capture: `${id.slice(7)}-${sample.sample}-${attempt.attempt}`, ...(simulator ? { simulator } : {}), started: async container => { attempt.container = container; await persist(); } });
      } else {
      const endpoints = plan.runner.harness.endpoints, model = plan.runner.model;
      if (!endpoints || !model) throw new Error("This harness names no model endpoint to replay against");
      const tree = await materialize({ bundle, base: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, candidate: { digest: plan.candidate_tree, directory: join(directory, "inputs/candidate") }, contract: plan.runner.harness, bindings: plan.runner.bindings, directory: root, env: plan.runner.env });
      const dialect = resolveModelDialect(endpoints.model.dialect);
      if (!dialect) throw new Error(`Unsupported model dialect: ${endpoints.model.dialect}`);
      const headers = modelHeaders(plan.start === "echo" ? undefined : model.headers);
      const start = plan.start === "mark" ? { at: bundle.manifest.mark! } : plan.start;
      const emulators: NonNullable<EngineOptions["emulators"]>[number][] = [];
      for (const [index, plugin] of plan.runner.plugins.entries()) {
        const pluginRoot = join(root, "emulators", String(index));
        await mkdir(join(pluginRoot, "inputs"), { recursive: true, mode: 0o700 });
        if (plugin.snapshot) await writeFile(join(pluginRoot, "inputs/snapshot"), bundle.files.get(plugin.snapshot)!);
        await writeFile(join(pluginRoot, "inputs/seed"), plugin.seed ? bundle.files.get(plugin.seed)! : JSON.stringify({ seed: digest(`${id}:${sample.sample}`) }));
        await writeClockFile(join(pluginRoot, "clock"), bundle.manifest.clock?.time ?? evidence[0]?.ts.wall ?? new Date(0));
        emulators.push({ plugin: { directory: join(directory, "inputs/plugins", String(index)), descriptor: plugin.descriptor }, options: { context: { ...(plugin.snapshot ? { snapshot: "/inputs/snapshot" } : {}), seed: "/inputs/seed" }, env: plugin.env, replay: { sandbox, spec: { image: plugin.image, mounts: [{ source: join(directory, "inputs/plugins", String(index)), target: "/plugin", readOnly: true }, { source: join(pluginRoot, "inputs"), target: "/inputs", readOnly: true }], workdir: "/plugin", clockFile: join(pluginRoot, "clock"), dontFakeMonotonic: true } } } });
      }
      engine = await startEngine({ evidence: { events: evidence, body: event => bundleBody(bundle, event) }, ...(recovering ? { resume: recovery } : {}), emulators, simulator, connectors: bundle.manifest.connectors, start,
        entityMaps: Object.fromEntries(plan.runner.plugins.map(plugin => [plugin.descriptor.connector, plugin.descriptor.entity_map])), volatile: Object.fromEntries(plan.runner.plugins.map(plugin => [plugin.descriptor.connector, plugin.descriptor.volatile ?? []])),
        clock: { start: bundle.manifest.clock?.time ?? evidence[0]?.ts.wall }, routes: { ...tree.routes, http: { ...Object.fromEntries(plan.runner.plugins.flatMap(plugin => (plugin.descriptor.recognize.hosts ?? []).map(host => [host, plugin.descriptor.connector]))), ...tree.routes.http, "phoenix-model": model.connector, "phoenix-model:8080": model.connector } },
        model: { connector: model.connector, dialect, selection: plan.model, provider: { url: model.url, headers }, ...(plan.login_context ? { loginContext: plan.login_context } : {}) },
        sample: { root: join(root, "trace"), metadata: { capture: `${id.slice(7)}-${sample.sample}-${attempt.attempt}`, harness: { name: plan.runner.harness.name, tree: plan.candidate_tree }, recipe: { name: "runner", version: "1" }, routes: ["tap"], started_at: bundle.manifest.clock?.time ?? evidence[0]?.ts.wall ?? new Date(0).toISOString(), boot_id: `${id}-${sample.sample}-${attempt.attempt}` } }, hmacKey });
      await writeClockFile(join(root, "clock"), engine.clock.now());
      engine.clock.onAnchor(time => { clockWrites = clockWrites.then(() => writeClockFile(join(root, "clock"), time)); });
      const running = await sandbox.start({ image: plan.harness_image, argv: tree.argv, env: { ...tree.env, TZ: bundle.manifest.clock?.timezone ?? "UTC" }, mounts: [{ source: tree.directory, target: "/worktree" }, { source: join(root, "support"), target: "/phoenix", readOnly: true }], clockFile: join(root, "clock"), workdir: "/worktree", virtualTime: engine.clock.now().toISOString(), clockProbe: plan.clock_probe, dontFakeMonotonic: true });
      process = running.process; attempt.container = process.id;
      await persist();
      process.stdin.end();
      process.stdout.resume(); process.stderr.resume();
      const connections = (async () => { for await (const connection of running.channel) engine!.accept(connection); })().then(() => ({ kind: "interrupted" as const, why: "engine channel closed" }), () => ({ kind: "interrupted" as const, why: "engine channel closed" }));
      outcome = await Promise.race([
        ...("serve" in plan.runner.harness.run ? [submitTask(running.channel, plan.runner.harness.run, bundle.manifest.prompt ?? "", submission.signal)] : []),
        process.exited.then(({ code }) => ({ kind: "finished" as const, code })),
        process.interrupted.then(error => ({ kind: "interrupted" as const, why: error.message })),
        engine.stopped.then(stop => stop.kind === "diverged" ? { kind: "diverged" as const, trigger: stop.divergence.trigger, detail: stop.divergence.detail } : stop),
        connections,
      ]);
      if (outcome.kind === "finished" && plan.start === "echo" && !engine.prefixComplete()) outcome = { kind: "diverged", trigger: "prefix-drift", detail: "Harness exited before consuming the complete echo prefix" };
      if (outcome.kind === "finished") for (const plugin of plan.runner.plugins) if (!bundle.manifest.connectors?.[plugin.descriptor.connector]?.skip_resolvers?.includes("emulator")) states.set(plugin.descriptor.connector, await engine.state(plugin.descriptor.connector));
      await save(join(root, "clock-report.json"), process.clock);
      }
    } catch (error) { outcome = { kind: error instanceof EmulatorStartError ? "not-run" : "interrupted", why: error instanceof Error ? error.message : String(error) }; }
    finally {
      submission.abort();
      await process?.stop().catch(() => {});
      await engine?.close();
      await clockWrites;
    }
    const clockReport = await optional<ClockReport>(join(root, "clock-report.json"));
    const context: FidelityContext = { source: bundle.manifest.source, connectors: Object.fromEntries(Object.entries(bundle.manifest.connectors ?? {}).map(([name, connector]) => [name, { coverage_tier: connector.tier, origin: connector.origin, routes: connector.routes, read_only: connector.read_only, ...(plan.runner.plugins.find(p => p.descriptor.connector === name) ? { plugin_tier: plan.runner.plugins.find(p => p.descriptor.connector === name)!.descriptor.tier } : {}) }])), start: plan.start, prefix_edits: engine?.prefixEdits() ?? [], container_runtime: plan.container_runtime, clock: clockReport ?? { clock: "unknown" }, processes: clockReport?.binaries ?? [], ...("serve" in plan.runner.harness.run ? { earlier_tasks_not_replayed: true } : {}) };
    const capture = `${id.slice(7)}-${sample.sample}-${attempt.attempt}`;
    const contextEvent: TraceEvent = { v: 1, capture, stream: "runner", seq: 0, id: "runner:0", kind: "meta", op: "fidelity.context", ts: { wall: engine?.clock.now().toISOString() ?? new Date().toISOString(), mono: globalThis.process.hrtime.bigint().toString() }, body: { inline: JSON.stringify(context) } };
    const limitations: TraceEvent = { ...contextEvent, seq: 1, id: "runner:1", op: "fidelity.workdir", body: { inline: JSON.stringify({ raw_address_reporting: false, snapshot_unread: bundle.manifest.workdir ? JSON.parse(Buffer.from(bundle.files.get(bundle.manifest.workdir)!).toString()).unread : [] }) } };
    if (engine || plan.runner.recipe) {
      const writer = createTraceWriter(join(root, "trace"), { capture, stream: "runner" });
      if (writer.append(contextEvent) !== "queued" || writer.append(limitations) !== "queued") throw new Error("Runner trace context was dropped");
      let seq = 2;
      for (const [connector, value] of states) {
        const event: TraceEvent = { ...contextEvent, seq, id: `runner:${seq++}`, connector, op: "end_state", body: { inline: JSON.stringify(value) } };
        if (writer.append(event) !== "queued") throw new Error("Runner end-state trace was dropped");
      }
      await writer.close();
    }
    const recorded = await sampleTrace(join(root, "trace"));
    const trace = recorded.events;
    const expectedStates = Object.fromEntries((bundle.check.expect ?? []).flatMap(exp => "end_state" in exp ? [[exp.end_state.equals, JSON.parse(Buffer.from(bundle.files.get(exp.end_state.equals)!).toString())]] : []));
    const boundary = trace.find(e => e.kind === "meta" && e.op === "start-point");
    const assessed = await evaluateCheck(bundle.check, { trace, blobs: recorded.blobs, ...(boundary ? { startAfter: eventId(boundary) } : {}) }, { expectedStates, custom: customCheckHost({ checksDirectory: join(directory, "inputs/bundle/checks"), workDirectory: root, image: plan.harness_image, sandbox }) });
    const verdict = sampleVerdict({ ...assessed, diverged: outcome.kind === "diverged" });
    const report = fidelityReport(engine || plan.runner.recipe ? trace : [contextEvent, limitations], recorded.blobs);
    if (outcome.kind === "diverged") {
      if (!report.divergences.length) report.divergences.push({ event: "runner", detail: outcome });
      report.grade = "blocked";
    }
    await save(join(root, "fidelity.json"), report);
    await save(join(root, "assessment.json"), assessed);
    await save(join(root, "outcome.json"), outcome);
    if (outcome.kind === "not-run") {
      attempt.status = "finished"; attempt.cause = `could not run: ${outcome.why}`;
      sample.complete = true; sample.status = "unassessed"; sample.expectations = [];
    } else if (outcome.kind === "interrupted") {
      attempt.status = "interrupted"; attempt.cause = outcome.why;
    } else if (recovering && outcome.kind === "diverged" && outcome.trigger === "prefix-drift" && verdict.status !== "fail") {
      const priors = await Promise.all(sample.attempts.slice(sample.attempts.findLastIndex(attempt => attempt.fresh_after_drift) + 1, -1).map(attempt => optional<Awaited<ReturnType<typeof evaluateCheck>>>(join(directory, "samples", String(sample.sample), String(attempt.attempt), "assessment.json"))));
      const prior = priors.find(prior => prior?.expectations.some(e => e.outcome === "fail" && e.irreversible && !e.tainted));
      if (prior) {
        attempt.status = "finished";
        sample.status = "fail"; sample.discounted = false; sample.leaned_on_made_up = false; sample.complete = true; sample.expectations = prior.expectations;
        await persist();
        return;
      }
      attempt.status = "finished"; attempt.cause = "recovery prefix drift; restarting at the original start point";
      attempt.fresh_after_drift = true;
      await persist();
      await this.#sample({ ...input, sample });
      return;
    } else {
      attempt.status = "finished";
      sample.complete = true;
      sample.status = verdict.status;
      sample.discounted = verdict.discounted;
      sample.leaned_on_made_up = verdict.leaned_on_made_up;
      sample.expectations = assessed.expectations;
      if (plan.runner.recipe) sample.answers = answerSources(trace);
      if (outcome.kind === "finished" && outcome.code !== 0) { sample.status = "fail"; attempt.cause = `candidate exited ${outcome.code}`; }
      if (plan.start === "echo" && outcome.kind === "diverged") await save(echoDriftPath(this.#options.root, plan.base_tree, plan.login_context), { result: id, cause: outcome.detail });
    }
    await persist();
  }
}
