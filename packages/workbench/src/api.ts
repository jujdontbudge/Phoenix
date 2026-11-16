import { spawn } from "node:child_process";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareBaseline, confirmDiscount, countsTowardPass, momentVerdict, type MomentVerdict } from "@phoenix/checks";
import type { FidelityReport } from "@phoenix/fidelity";
import type { HarnessContract, ReplayPlan, ReplayResult, TraceEvent } from "@phoenix/formats";
import { Runner, treeDigest, type ReplayRequest, type ReplayStatus } from "@phoenix/runner";
import { BlobStore, bundleApproval, digest, readApprovalsLedger, readCapture, readMomentBundle, type MomentBundle } from "@phoenix/store";
import { exportTree, freezeCandidate, git, isEditable, openWorkspace, resolveInTree, type Change, type WorkspaceState } from "./workspace.ts";

export type StartPoint = ReplayRequest["start"];
export type ReplaySettings = Omit<ReplayRequest, "moment" | "base" | "candidate" | "harness" | "start" | "samples">;
export type TraceRef = { moment: string } | { replay: string; sample: number; attempt?: number };
export interface Range { from?: number; limit?: number }

interface ReplaySet {
  id: string;
  created: string;
  candidate: { digest: string; commit: string; changes: Change[] };
  base: string;
  start?: StartPoint;
  moments: { moment: string; replay: string; baseline?: string }[];
}

const BODY_LIMIT = 2000;
const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));

async function json<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function durable(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "w", 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}
const describe = (bytes: Uint8Array): string => {
  const text = Buffer.from(bytes).toString("utf8");
  return text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) + `… [${text.length - BODY_LIMIT} more characters]` : text;
};

export class Workbench {
  readonly #home: string;
  readonly #root: string;
  readonly #state: WorkspaceState;
  readonly #tree: string;
  readonly #contract: HarnessContract;
  readonly #runner: Runner;
  readonly #ledger: string;
  readonly #concurrency?: number;

  private constructor(home: string, opened: Awaited<ReturnType<typeof openWorkspace>>, ledger: string, concurrency?: number) {
    this.#home = home; this.#root = opened.root; this.#state = opened.state; this.#tree = opened.tree; this.#contract = opened.contract;
    this.#ledger = ledger; this.#concurrency = concurrency;
    this.#runner = new Runner({ root: home, ledger, concurrency });
  }

  static async open(options: { home: string; workspace: string; ledger?: string; concurrency?: number }): Promise<Workbench> {
    return new Workbench(options.home, await openWorkspace(options.home, options.workspace), options.ledger ?? join(options.home, "approvals.jsonl"), options.concurrency);
  }

  async #bundles(): Promise<MomentBundle[]> {
    const bundles: MomentBundle[] = [];
    for (const entry of await readdir(this.#state.moments, { withFileTypes: true })) {
      if (!entry.isDirectory() || !await lstat(join(this.#state.moments, entry.name, "moment.lock.json")).then(() => true, () => false)) continue;
      bundles.push(await readMomentBundle(join(this.#state.moments, entry.name)));
    }
    return bundles;
  }

  async #bundle(id: string): Promise<MomentBundle> {
    const bundle = (await this.#bundles()).find(b => b.manifest.id === id);
    if (!bundle) throw new Error(`No locked moment named ${id}`);
    return bundle;
  }

  async listMoments() {
    const ledger = (await readApprovalsLedger(this.#ledger)).entries;
    return (await this.#bundles()).map(bundle => {
      let approval: unknown = null;
      try { approval = bundleApproval(bundle, ledger); } catch {}
      return {
        id: bundle.manifest.id, source: bundle.manifest.source, prompt: bundle.manifest.prompt, mark: bundle.manifest.mark, default_start: bundle.manifest.start ?? "mark",
        connectors: Object.fromEntries(Object.entries(bundle.manifest.connectors ?? {}).map(([name, c]) => [name, { surface: c.surface, tier: c.tier }])),
        check: Buffer.from(bundle.files.get("check.yaml")!).toString("utf8"), check_hash: bundle.lock.check, lock_hash: bundle.lockHash, ledger_entry: approval,
      };
    });
  }

  async readTrace(ref: TraceRef, range: Range = {}) {
    let events: TraceEvent[], body: (event: TraceEvent) => Promise<Uint8Array>;
    if ("moment" in ref) {
      const bundle = await this.#bundle(ref.moment);
      const paths = new Set(Object.values(bundle.manifest.connectors ?? {}).flatMap(c => (c.data ?? []).filter(d => d.kind === "run-evidence").map(d => d.path)));
      events = [...paths].flatMap(path => Buffer.from(bundle.files.get(path)!).toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceEvent));
      body = async event => !event.body ? new Uint8Array() : "inline" in event.body ? Buffer.from(event.body.inline) : bundle.files.get(`data/blobs/${event.body.blob.slice(7)}`) ?? Buffer.from("[missing blob]");
    } else {
      await this.#owned(ref.replay);
      const status = await this.#runner.status(ref.replay);
      const sample = status.samples.find(s => s.sample === ref.sample);
      if (!sample) throw new Error(`No sample ${ref.sample} in ${ref.replay}`);
      const attempt = ref.attempt ?? sample.attempts.at(-1)?.attempt ?? 0;
      const root = join(this.#runner.directory(ref.replay), "samples", String(ref.sample), String(attempt), "trace");
      events = [...(await readCapture(root)).allEvents];
      const blobs = new BlobStore(root);
      body = async event => !event.body ? new Uint8Array() : "inline" in event.body ? Buffer.from(event.body.inline) : blobs.get(event.body.blob);
    }
    const from = range.from ?? 0, limit = Math.min(range.limit ?? 50, 500);
    const page = await Promise.all(events.slice(from, from + limit).map(async event => ({ ...event, body: event.body ? { text: describe(await body(event)) } : undefined })));
    return { total: events.length, from, events: page };
  }

  async listEditable() {
    const scope = this.#state.harness.path || ".";
    const strip = (path: string) => this.#state.harness.path ? path.slice(this.#state.harness.path.length + 1) : path;
    const tracked = (await git(join(this.#root, "tree"), ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", scope])).split("\0").filter(Boolean).map(strip);
    return { globs: this.#contract.editable, files: [...new Set(tracked)].filter(path => isEditable(this.#contract, path)).sort() };
  }

  async #safe(path: string): Promise<string> {
    const relative = resolveInTree(this.#tree, path);
    let current = this.#tree;
    for (const part of relative.split("/")) {
      current = join(current, part);
      const stat = await lstat(current).catch(() => undefined);
      if (!stat) break;
      if (stat.isSymbolicLink()) throw new Error(`Refused: ${relative} goes through a symlink`);
    }
    return relative;
  }

  async readFile(path: string): Promise<string> {
    return readFile(join(this.#tree, await this.#safe(path)), "utf8");
  }

  async editFile(path: string, content: string) {
    const relative = await this.#safe(path);
    if (!isEditable(this.#contract, relative)) throw new Error(`Refused: ${relative} is not an editable path. Editable globs: ${this.#contract.editable.join(", ")}`);
    await durable(join(this.#tree, relative), content);
    return { path: relative, bytes: Buffer.byteLength(content) };
  }

  async startReplay(request: { moments?: string[]; start?: StartPoint; samples?: ReplayRequest["samples"] } = {}) {
    const bundles = await this.#bundles();
    const chosen = request.moments?.length ? request.moments.map(id => { const b = bundles.find(x => x.manifest.id === id); if (!b) throw new Error(`No locked moment named ${id}`); return b; }) : bundles;
    if (!chosen.length) throw new Error("The moment set is empty");
    const candidate = await freezeCandidate(this.#root, this.#state, this.#contract);
    const baseDirectory = await exportTree(this.#root, join(this.#root, "tree"), this.#state.base, this.#state.harness.path);
    const base = { digest: await treeDigest(baseDirectory), directory: baseDirectory };
    const settings = JSON.parse(await readFile(this.#state.settings, "utf8")) as ReplaySettings;
    const moments: ReplaySet["moments"] = [];
    for (const bundle of chosen) {
      const replay: ReplayRequest = { ...settings, moment: bundle.root, base, candidate: { digest: candidate.digest, directory: candidate.directory }, harness: this.#contract, start: request.start ?? bundle.manifest.start ?? "mark", ...(request.samples ? { samples: request.samples } : {}) };
      const id = await this.#runner.plan(replay);
      const baseline = candidate.digest === base.digest ? undefined : await this.#runner.plan({ ...replay, candidate: base });
      moments.push({ moment: bundle.manifest.id, replay: id, ...(baseline ? { baseline } : {}) });
    }
    const id = digest(JSON.stringify({ candidate: candidate.digest, moments }));
    const set: ReplaySet = { id, created: new Date().toISOString(), candidate: { digest: candidate.digest, commit: candidate.commit, changes: candidate.changes }, base: base.digest, ...(request.start ? { start: request.start } : {}), moments };
    const path = join(this.#root, "replays", id.slice(7) + ".json");
    if (!await json(path)) await durable(path, JSON.stringify(set, null, 2) + "\n");
    await durable(join(this.#root, "latest.json"), JSON.stringify({ replay: id }) + "\n");
    for (const entry of moments) await this.#launch(entry.replay);
    return { replay: id, candidate: set.candidate, moments, next: "Poll getReplay until done, then runChecks" };
  }

  async #set(id: string): Promise<ReplaySet> {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Replay id");
    const set = await json<ReplaySet>(join(this.#root, "replays", id.slice(7) + ".json"));
    if (!set) throw new Error(`No Replay ${id} in this workspace`);
    return set;
  }

  async #owned(replay: string): Promise<void> {
    for (const name of await readdir(join(this.#root, "replays")).catch(() => [])) {
      const set = await json<ReplaySet>(join(this.#root, "replays", name));
      if (set?.moments.some(m => m.replay === replay || m.baseline === replay)) return;
    }
    throw new Error(`No Replay ${replay} in this workspace`);
  }

  async #running(replay: string): Promise<boolean> {
    const lock = await json<{ pid: number }>(join(this.#runner.directory(replay), "run.lock")).catch(() => undefined);
    if (!lock) return false;
    try { process.kill(lock.pid, 0); return true; } catch { return false; }
  }

  async #launch(replay: string): Promise<boolean> {
    if (await this.#running(replay)) return false;
    if ((await this.#runner.status(replay)).state === "finished") return false;
    const log = join(this.#root, "logs", replay.slice(7) + ".log");
    await mkdir(dirname(log), { recursive: true, mode: 0o700 });
    const output = await open(log, "a", 0o600);
    const child = spawn(process.execPath, [worker, this.#home, this.#ledger, String(this.#concurrency ?? 2), replay], { detached: true, stdio: ["ignore", output.fd, output.fd] });
    child.unref();
    await output.close();
    return true;
  }

  async getReplay(id: string) {
    const set = await this.#set(id);
    const summary = async (replay: string) => {
      const status: ReplayStatus = await this.#runner.status(replay);
      const running = await this.#running(replay);
      const resumed = !running && status.state !== "finished" ? await this.#launch(replay) : false;
      return { replay, state: status.state, running: running || resumed, ...(resumed ? { resumed: true } : {}), ...(status.error ? { error: status.error } : {}),
        samples: status.samples.map(s => ({ sample: s.sample, tiebreak: s.tiebreak, status: s.status, complete: s.complete, attempts: s.attempts.map(a => ({ attempt: a.attempt, status: a.status, ...(a.cause ? { cause: a.cause } : {}) })) })),
        ...(status.result ? { verdict: status.result.verdict, fidelity_grade: status.result.fidelity_grade } : {}) };
    };
    const moments = [];
    for (const entry of set.moments) moments.push({ moment: entry.moment, candidate: await summary(entry.replay), ...(entry.baseline ? { baseline: await summary(entry.baseline) } : {}) });
    return { replay: id, candidate: set.candidate, done: moments.every(m => m.candidate.state === "finished" && (!m.baseline || m.baseline.state === "finished")), moments };
  }

  async #samples(replay: string, bundle: MomentBundle) {
    const status = await this.#runner.status(replay);
    const result = status.state === "finished" ? status.result : undefined;
    const samples = status.samples.map(({ complete: _, ...sample }) => ({ ...sample, discounted: sample.discounted ?? false,
      expectations: sample.expectations.map(e => ({ ...e, expect: bundle.check.expect?.[e.expectation] })),
      ...(bundle.check.intent !== undefined && !sample.intent && sample.status === "unassessed" && sample.expectations.length > 0 && sample.expectations.every(e => e.outcome === "pass") ? { needs_intent_judgment: true } : {}) }));
    const plan = await json<{ samples: { base: number; tiebreak: number } }>(join(this.#runner.directory(replay), "plan.json"));
    return { status, result, samples, verdict: momentVerdict(samples, plan!.samples) };
  }

  async #confirmation(entry: ReplaySet["moments"][number], result: ReplayResult): Promise<ReplayResult["discount"]> {
    if (!result.discount.discounted || result.discount.confirmed) return result.discount;
    const resultHash = digest(await readFile(join(this.#runner.directory(entry.replay), "result.json")));
    const accepted = (await readApprovalsLedger(this.#ledger)).entries.findLast(e => e.how === "pass-accepted" && e.moment === entry.moment && e.revision === result.ledger_entry.revision && e.result_hash === resultHash);
    if (!accepted) return result.discount;
    const plan = JSON.parse(await readFile(join(this.#runner.directory(entry.replay), "plan.json"), "utf8")) as ReplayPlan;
    return confirmDiscount({ moment: entry.moment, revision: result.ledger_entry.revision, resultHash, plan, result, trace: [] }, { how: "pass-accepted", entry: accepted });
  }

  async runChecks(id: string) {
    const set = await this.#set(id);
    const moments = [];
    for (const entry of set.moments) {
      const bundle = await this.#bundle(entry.moment);
      const candidate = await this.#samples(entry.replay, bundle);
      const baseline = entry.baseline ? await this.#samples(entry.baseline, bundle) : candidate;
      const result = candidate.status.result;
      if (!result) { moments.push({ moment: entry.moment, replay: entry.replay, state: candidate.status.state, verdict: "incomplete" as const }); continue; }
      const settled = !!candidate.result && !!baseline.result;
      const verdict: MomentVerdict = settled ? { ...candidate.verdict, discount: candidate.verdict.discount.discounted ? await this.#confirmation(entry, result) : candidate.verdict.discount }
        : { ...candidate.verdict, verdict: "incomplete", meets_check: undefined, discount: { discounted: false } };
      const compared = entry.baseline ? compareBaseline(verdict, baseline.verdict) : { target_pass: false, baseline_did_not_reproduce: verdict.verdict === "meets-check" };
      moments.push({
        moment: entry.moment, replay: entry.replay, ...(entry.baseline ? { baseline_replay: entry.baseline } : {}), state: candidate.status.state, check_hash: result.check, ledger_entry: result.ledger_entry,
        intent: bundle.check.intent ?? null, verdict: verdict.verdict, meets_check: verdict.meets_check ?? null, discount: verdict.discount, counts: verdict.counts, scheduled: verdict.scheduled,
        baseline: { verdict: baseline.verdict.verdict, counts: baseline.verdict.counts, meets_check: baseline.verdict.meets_check ?? null },
        improved: "improved" in compared ? compared.improved ?? null : null, target_pass: compared.target_pass, baseline_did_not_reproduce: compared.baseline_did_not_reproduce,
        counts_toward_patch: countsTowardPass(verdict), fidelity_grade: result.fidelity_grade ?? null,
        leaned_on_made_up: verdict.verdict === "incomplete" ? null : result.leaned_on_made_up ?? false, files_copy: result.files_copy ?? null,
        samples: candidate.samples, baseline_samples: entry.baseline ? baseline.samples : undefined,
      });
    }
    const complete = moments.every(m => m.verdict !== "incomplete");
    const targets = moments.filter(m => "baseline" in m && m.baseline && m.baseline.meets_check === false);
    const others = moments.filter(m => !targets.includes(m));
    const set_pass = complete && targets.length > 0 && targets.every(m => "target_pass" in m && m.target_pass) && others.every(m => "counts_toward_patch" in m && m.counts_toward_patch);
    return { replay: id, candidate: set.candidate, complete, set_pass, moments };
  }

  async judgeIntent(replay: string, sample: number, met: boolean, reason: string) {
    await this.#owned(replay);
    if (!reason.trim()) throw new Error("A judgment needs a reason");
    await this.#runner.judge(replay, sample, { met, reason });
    return { replay, sample, met, reason, next: "Judge the other samples, then poll getReplay: it recomputes the verdict and runs a tiebreak sample if the judgments disagree. Then runChecks" };
  }

  async fidelityReport(id: string) {
    const set = await this.#set(id);
    const moments = [];
    for (const entry of set.moments) {
      const status = await this.#runner.status(entry.replay);
      const samples = [];
      for (const sample of status.samples) {
        const attempt = sample.attempts.at(-1);
        if (!attempt) continue;
        const report = await json<FidelityReport>(join(this.#runner.directory(entry.replay), "samples", String(sample.sample), String(attempt.attempt), "fidelity.json"));
        if (report) samples.push({ sample: sample.sample, attempt: attempt.attempt, report });
      }
      moments.push({ moment: entry.moment, replay: entry.replay, grade: status.result?.fidelity_grade ?? null, samples });
    }
    return { replay: id, moments };
  }

  async makePatch(options: { pullRequest?: boolean } = {}) {
    const latest = await json<{ replay: string }>(join(this.#root, "latest.json"));
    if (!latest) throw new Error("Start a Replay before making a patch");
    const set = await this.#set(latest.replay);
    const checks = await this.runChecks(set.id);
    if (!checks.complete) throw new Error("The latest Replay is not complete; poll getReplay and judge any intent first");
    const tree = join(this.#root, "tree");
    const prefix = this.#state.harness.path ? this.#state.harness.path + "/" : "";
    const files = (await git(tree, ["diff", "--name-only", "-z", "--no-renames", this.#state.base, set.candidate.commit])).split("\0").filter(Boolean);
    const outside = files.filter(path => !path.startsWith(prefix) || !isEditable(this.#contract, path.slice(prefix.length)));
    if (outside.length) throw new Error(`Refused: the candidate touches non-editable paths: ${outside.join(", ")}`);
    const patch = await git(tree, ["diff", "--binary", "--no-renames", this.#state.base, set.candidate.commit]);
    const directory = join(this.#root, "patches", set.candidate.commit.slice(0, 12));
    const claims = checks.moments.filter(m => "counts_toward_patch" in m && m.counts_toward_patch).map(m => m.moment);
    const result = {
      replay: set.id, base: { commit: this.#state.base, tree: set.base }, candidate: set.candidate, files, set_pass: checks.set_pass, claims,
      moments: checks.moments.map(m => !("check_hash" in m) ? m : {
        moment: m.moment, replay: m.replay, verdict: m.verdict, meets_check: m.meets_check, improved: m.improved, target_pass: m.target_pass,
        samples: m.counts, scheduled: m.scheduled, baseline: m.baseline, check_hash: m.check_hash, ledger_entry: m.ledger_entry, fidelity_grade: m.fidelity_grade,
        discount: m.discount.discounted ? { discounted: true, confirmed: m.discount.confirmed ?? "unconfirmed" } : { discounted: false },
        intent_judgments: m.samples.flatMap(s => s.intent ? [{ sample: s.sample, ...s.intent }] : []),
      }),
    };
    await durable(join(directory, "candidate.patch"), patch);
    await durable(join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
    const output = { patch: join(directory, "candidate.patch"), result: join(directory, "result.json"), files, set_pass: checks.set_pass, claims };
    if (!options.pullRequest) return output;
    if (!this.#state.harness.git) throw new Error(`This harness is not in git, so it gets a patch file only: ${output.patch}`);
    return { ...output, pull_request: await this.#pullRequest(set, result) };
  }

  async #pullRequest(set: ReplaySet, result: { claims: string[]; set_pass: boolean; moments: unknown[] }) {
    const repo = this.#state.harness.repo;
    const branch = `phoenix/candidate-${set.candidate.commit.slice(0, 12)}`;
    const target = this.#state.harness.branch;
    if (!target) throw new Error("The harness checkout had no branch when the workspace was made, so there is no pull-request base");
    await git(repo, ["fetch", "-q", "origin", target]);
    const prefix = this.#state.harness.path ? this.#state.harness.path + "/" : "";
    const proposed = (await git(repo, ["diff", "--name-only", "-z", "--no-renames", `FETCH_HEAD...${set.candidate.commit}`])).split("\0").filter(Boolean);
    const forbidden = proposed.filter(path => !path.startsWith(prefix) || !isEditable(this.#contract, path.slice(prefix.length)));
    if (forbidden.length) throw new Error(`Refused: a pull request against origin/${target} would also carry non-editable paths: ${forbidden.join(", ")}. Make the workspace from a base commit on that branch.`);
    const remote = (await git(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).trim().split(/\s+/)[0];
    if (remote && remote !== set.candidate.commit) throw new Error(`Branch ${branch} already exists on origin at another commit`);
    if (!remote) await git(repo, ["push", "origin", `${set.candidate.commit}:refs/heads/${branch}`]);
    const gh = (args: string[]) => new Promise<string>((resolve, reject) => {
      const child = spawn("gh", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`gh ${args[0]} ${args[1]} failed: ${err.trim()}`)));
    });
    const existing = JSON.parse(await gh(["pr", "list", "--head", branch, "--state", "all", "--json", "url"])) as { url: string }[];
    if (existing[0]) return { branch, url: existing[0].url, existed: true };
    const rows = (result.moments as { moment: string; verdict?: string; samples?: { pass: number }; scheduled?: number; baseline?: { counts: { pass: number } }; fidelity_grade?: string; check_hash?: string; ledger_entry?: { who: string; at: string } }[])
      .map(m => `| ${m.moment} | ${m.verdict} | ${m.samples?.pass ?? "?"}/${m.scheduled ?? "?"} | ${m.baseline?.counts.pass ?? "?"}/${m.scheduled ?? "?"} | ${m.fidelity_grade ?? "?"} | \`${m.check_hash?.slice(0, 19)}\` approved by ${m.ledger_entry?.who} |`);
    const body = [`Phoenix Workbench candidate \`${set.candidate.digest}\`, replayed as \`${set.id}\`.`, "",
      "| Moment | Verdict | Passing samples | Baseline | Fidelity | Check |", "|---|---|---|---|---|---|", ...rows, "",
      `Set pass: ${result.set_pass ? "yes" : "no"}. Confirmed claims: ${result.claims.join(", ") || "none"}.`].join("\n");
    const args = ["pr", "create", "--head", branch, "--title", `Phoenix candidate ${set.candidate.commit.slice(0, 12)}`, "--body", body, ...(this.#state.harness.branch ? ["--base", this.#state.harness.branch] : [])];
    return { branch, url: (await gh(args)).trim(), existed: false };
  }
}
