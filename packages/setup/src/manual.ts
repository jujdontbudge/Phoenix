import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { validate, type MomentManifest, type TraceEvent, type WorkdirSnapshot } from "@phoenix/formats";
import { BlobStore, readCapture, writeMomentBundle } from "@phoenix/store";
import { autoLock } from "@phoenix/approvals";

type Start = "beginning" | "mark";
type Surface = "mcp" | "cli" | "http";

const eventId = (e: TraceEvent) => e.id ?? `${e.stream}:${e.seq}`;

function checkDraft(text: string): string {
  const result = validate("check", parse(text));
  if (!result.ok) throw new Error(`Invalid check: ${result.errors.join("; ")}`);
  return text;
}

function chosenWorkdir(snapshots: ReadonlyMap<string, WorkdirSnapshot>, name: string | false | undefined, task: string): WorkdirSnapshot | undefined {
  if (name === false) return undefined;
  if (name !== undefined) {
    const snapshot = snapshots.get(name);
    if (!snapshot) throw new Error(`No working-directory snapshot named ${name}; the capture has: ${[...snapshots.keys()].join(", ") || "none"}`);
    return snapshot;
  }
  const own = task ? [...snapshots.values()].find((s) => (s as { task?: unknown }).task === task) : snapshots.get("default");
  if (own) return own;
  if (snapshots.size > 1) throw new Error(`Choose a working-directory snapshot: ${[...snapshots.keys()].join(", ")}`);
  return snapshots.values().next().value;
}

function withIgnoredChoice(snapshot: WorkdirSnapshot, include: boolean): WorkdirSnapshot {
  if (include) return snapshot;
  return {
    ...snapshot,
    ignored_copied: false,
    entries: snapshot.entries.map((entry) => {
      if (entry.state !== "ignored-copied") return entry;
      if (entry.size === undefined || entry.mtime === undefined) throw new Error(`Ignored file has no size or mtime to list: ${entry.path}`);
      return { path: entry.path, state: "ignored", size: entry.size, mtime: entry.mtime };
    }),
  };
}

export interface SnapshotMomentOptions {
  capture: string;
  task?: string;
  mark: string;
  start?: Start;
  id: string;
  out: string;
  connectors: readonly { name: string; surface: Surface }[];
  check?: string;
  correction?: string;
  workdir?: string | false;
  includeIgnored?: boolean;
  prompt?: string;
  timezone?: string;
}

export interface PreparedMoment {
  manifest: MomentManifest;
  files: Map<string, string | Uint8Array>;
  blobs: Map<string, string>;
  events: TraceEvent[];
  workdir?: WorkdirSnapshot;
  store: BlobStore;
}

export async function createSnapshotMoment(o: SnapshotMomentOptions): Promise<MomentManifest> {
  const { manifest, files, blobs } = await prepareSnapshotMoment(o);
  await writeMomentBundle(o.out, { manifest, files, blobs });
  return manifest;
}

export async function prepareSnapshotMoment(o: Omit<SnapshotMomentOptions, "out">): Promise<PreparedMoment> {
  const view = await readCapture(o.capture);
  const run = { capture: view.metadata.capture, task: o.task ?? "" };
  if (!view.runs().some((r) => r.task === run.task)) throw new Error(`No run with task key "${run.task}" in capture ${run.capture}`);
  const events: TraceEvent[] = [];
  for await (const event of view.events(run)) events.push(event);
  const ids = events.map(eventId);
  const markIndex = ids.indexOf(o.mark);
  if (markIndex < 0) throw new Error(`Mark is not an event in this run: ${o.mark}`);
  const start = o.start ?? "mark";

  let check: string;
  if (o.check !== undefined) check = checkDraft(await readFile(o.check, "utf8"));
  else {
    const corrections = events.filter((e) => e.kind === "correction" && (o.correction === undefined || eventId(e) === o.correction));
    if (o.correction !== undefined && !corrections.length) throw new Error(`No Correction with id ${o.correction} in this run`);
    const usable = corrections.filter((e) => e.op !== "one-off");
    if (o.correction !== undefined && !usable.length) throw new Error(`Correction ${o.correction} is marked one-off and never becomes a check`);
    if (!usable.length) throw new Error("This run has no Correction to start the check from; write one with --check");
    if (usable.length > 1) throw new Error(`Choose a Correction: ${usable.map(eventId).join(", ")}`);
    const text = usable[0]!.body && "inline" in usable[0]!.body ? usable[0]!.body.inline : undefined;
    if (!text) throw new Error(`Correction ${eventId(usable[0]!)} has no inline text`);
    check = stringify({ phoenix_check: 1, samples: { base: 2, tiebreak: 1 }, scope: "continuation", intent: text });
  }

  const connectors: NonNullable<MomentManifest["connectors"]> = {};
  for (const { name, surface } of o.connectors) {
    const own = events.filter((e) => e.connector === name);
    if (!own.length) throw new Error(`Connector ${name} has no events in this run`);
    connectors[name] = {
      surface, routes: [...new Set(own.map((e) => e.route ?? "tap"))], tier: "recorded", origin: "captured", read_only: [],
      data: [{ path: "data/run.jsonl", kind: "run-evidence" }],
    };
  }

  const files = new Map<string, string | Uint8Array>([["data/run.jsonl", events.map((e) => JSON.stringify(e) + "\n").join("")], ["check.draft.yaml", check]]);
  const hashes = new Set(events.flatMap((e) => e.body && "blob" in e.body ? [e.body.blob] : []));
  const snapshot = chosenWorkdir(view.snapshots, o.workdir, run.task);
  let workdir: Pick<MomentManifest, "workdir" | "include_ignored"> = {};
  let selected: WorkdirSnapshot | undefined;
  if (snapshot) {
    if (o.includeIgnored && !snapshot.ignored_copied) throw new Error("The capture did not copy ignored files, so the moment cannot include them");
    const include = o.includeIgnored ?? snapshot.ignored_copied;
    selected = withIgnoredChoice(snapshot, include);
    files.set("data/workdir/run.json", JSON.stringify(selected, null, 2) + "\n");
    for (const entry of selected.entries) if (entry.blob) hashes.add(entry.blob);
    workdir = { workdir: "data/workdir/run.json", include_ignored: include };
  } else if (o.includeIgnored) throw new Error("No working-directory snapshot to include ignored files from");

  const { harness, recipe } = view.metadata;
  const manifest: MomentManifest = {
    phoenix_moment: 1, id: o.id, source: "snapshot", run, mark: o.mark, start,
    clock: { time: events[0]!.ts.wall, timezone: o.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone },
    ...(o.prompt !== undefined ? { prompt: o.prompt } : {}),
    ...workdir,
    ...(/^sha256:[0-9a-f]{64}$/.test(harness.tree) ? { harness: { name: harness.name, tree: harness.tree } } : {}),
    ...(recipe.version !== "unknown" ? { recipe_version: recipe.version } : {}),
    connectors,
  };
  const store = new BlobStore(o.capture);
  return { manifest, files, blobs: new Map([...hashes].map((hash) => [hash, store.path(hash)])), events, store, ...(selected ? { workdir: selected } : {}) };
}

async function seedFiles(root: string, prefix: string): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await seedFiles(root, path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Not a plain file in scenario: ${path}`);
  }
  return paths;
}

export async function createScenarioMoment(o: { from: string; out: string; home: string; who: string }): Promise<{ manifest: MomentManifest; locked: boolean }> {
  const result = validate("moment", parse(await readFile(join(o.from, "moment.yaml"), "utf8")));
  if (!result.ok) throw new Error(`Invalid moment: ${result.errors.join("; ")}`);
  const manifest = result.value;
  if (manifest.source !== "scenario") throw new Error("A Scenario's moment.yaml must say source: scenario");
  for (const [name, connector] of Object.entries(manifest.connectors ?? {}))
    if (connector.origin !== "seeded") throw new Error(`Scenario data is seeded, never captured: connector ${name}`);
  if (manifest.start !== undefined && manifest.start !== "beginning")
    throw new Error("A Scenario replays from the beginning only: Phoenix does not replay recorded LLM traffic to reach a later point");
  const files = new Map<string, Uint8Array>([["check.draft.yaml", Buffer.from(checkDraft(await readFile(join(o.from, "check.draft.yaml"), "utf8")))]]);
  for (const path of [...await seedFiles(o.from, "data"), ...await seedFiles(o.from, "checks")]) files.set(path, await readFile(join(o.from, path)));
  await writeMomentBundle(o.out, { manifest, files });
  if (manifest.lock !== "auto") return { manifest, locked: false };
  await autoLock(o.out, { home: o.home, who: o.who });
  return { manifest, locked: true };
}
