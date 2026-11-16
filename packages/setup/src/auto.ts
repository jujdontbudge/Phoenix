import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MomentManifest, TraceEvent, WorkdirSnapshot } from "@phoenix/formats";
import type { ModelProvider } from "@phoenix/model";
import { findPlugins } from "@phoenix/plugin-host";
import { writeMomentBundle } from "@phoenix/store";
import { prepareSnapshotMoment, type SnapshotMomentOptions } from "./manual.ts";
import { readEvidence } from "./evidence.ts";
import { classify, discoverConnectors, inferFormats, pickTier } from "./discover.ts";
import { fillGaps, type FilledItem, type MissingItem } from "./fill.ts";

export interface AutoSetupOptions extends Omit<SnapshotMomentOptions, "connectors"> {
  provider?: ModelProvider;
  plugins?: readonly string[];
  docs?: readonly string[];
}

export async function workdirTexts(snapshot: WorkdirSnapshot, get: (hash: string) => Promise<Uint8Array>): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const entry of snapshot.entries) {
    if (!entry.blob || (entry as { secrets?: unknown }).secrets === "unscanned" || entry.path.split("/").includes("node_modules")) continue;
    const bytes = await get(entry.blob);
    if (bytes.length > 64 * 1024) continue;
    try { texts.set(entry.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {}
  }
  return texts;
}

export async function setupSnapshotMoment(o: AutoSetupOptions): Promise<{ manifest: MomentManifest; fills: FilledItem[]; missing: MissingItem[] }> {
  const prepared = await prepareSnapshotMoment({ ...o, connectors: [] });
  const body = async (e: TraceEvent) => !e.body ? undefined : "inline" in e.body ? Buffer.from(e.body.inline) : prepared.store.get(e.body.blob);
  const evidence = await readEvidence(prepared.events, body);
  const files = prepared.workdir ? await workdirTexts(prepared.workdir, (hash) => prepared.store.get(hash)) : new Map<string, string>();
  const connectors = discoverConnectors(evidence);
  const corpus = new Map<string, string>([...files].map(([path, text]) => [`workdir:${path}`, text]));
  for (const doc of o.docs ?? []) corpus.set(`doc:${doc}`, await readFile(doc, "utf8"));
  const { fills, missing } = await fillGaps({ evidence, connectors, corpus, ...(o.provider ? { provider: o.provider } : {}) });
  const plugins = await findPlugins([...o.plugins ?? []]);
  for (const [name, connector] of Object.entries(connectors)) {
    const { read_only, plugin } = classify(name, connector, evidence, plugins);
    connector.read_only = read_only;
    if (plugin) {
      const pkg = JSON.parse(await readFile(join(plugin.directory, "package.json"), "utf8").catch(() => "{}")) as { name?: string; version?: string };
      connector.plugin = { name: pkg.name ?? plugin.descriptor.connector, version: pkg.version ?? "*" };
    }
    connector.tier = pickTier(connector, plugin, fills.some((f) => f.fill.connector === name && f.fill.tag === "synthesized"));
    const formats = inferFormats(name, connector, evidence);
    if (formats) prepared.files.set(`data/formats/${name}.json`, JSON.stringify(formats, null, 2) + "\n");
  }
  for (const { path, fill } of fills) prepared.files.set(path, JSON.stringify(fill, null, 2) + "\n");
  const manifest: MomentManifest = {
    ...prepared.manifest, ...(o.correction ? { correction: o.correction } : {}), connectors,
    ...(fills.length ? { fills: fills.map(({ path, fill }) => ({ path, tag: fill.tag, basis: fill.basis, producer: fill.producer })) } : {}),
  };
  await writeMomentBundle(o.out, { manifest, files: prepared.files, blobs: prepared.blobs });
  return { manifest, fills, missing };
}
