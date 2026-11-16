import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { validate, type FormatName, type FormatTypes, type TraceEvent } from "@phoenix/formats";
import { digest, type MomentBundle } from "@phoenix/store";

export function checked<F extends FormatName>(format: F, value: unknown): FormatTypes[F] {
  const result = validate(format, value);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function load<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function optional<T>(path: string): Promise<T | undefined> {
  try { return await load<T>(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function claim(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid })); await file.sync(); await file.close();
      return () => unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await load<{ pid: number }>(path);
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        await unlink(path); continue;
      }
      throw new Error(`Replay is already running in process ${owner.pid}`);
    }
  }
}

export const eventId = (event: TraceEvent): string => event.id ?? `${event.stream}:${event.seq}`;

export function bundleEvidence(bundle: MomentBundle): TraceEvent[] {
  const paths = new Set(Object.values(bundle.manifest.connectors ?? {}).flatMap(c => (c.data ?? []).filter(d => d.kind === "run-evidence").map(d => d.path)));
  const events: TraceEvent[] = [];
  for (const path of paths) {
    const bytes = bundle.files.get(path);
    if (!bytes) throw new Error(`Missing run evidence: ${path}`);
    for (const row of Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean)) events.push(checked("trace", JSON.parse(row)));
  }
  const ids = new Set<string>();
  for (const event of events) {
    const id = eventId(event);
    if (ids.has(id)) throw new Error(`Duplicate run event: ${id}`);
    ids.add(id);
    if (bundle.manifest.run && (event.capture !== bundle.manifest.run.capture || event.task !== undefined && event.task !== (bundle.manifest.run.task ?? ""))) throw new Error(`Evidence belongs to another run: ${id}`);
  }
  if (paths.size > 1) {
    const monotonic = events.every(e => e.ts.mono !== undefined);
    events.sort((a, b) => monotonic ? BigInt(a.ts.mono!) < BigInt(b.ts.mono!) ? -1 : BigInt(a.ts.mono!) > BigInt(b.ts.mono!) ? 1 : a.stream.localeCompare(b.stream) || a.seq - b.seq : a.ts.wall.localeCompare(b.ts.wall) || a.stream.localeCompare(b.stream) || a.seq - b.seq);
  }
  for (const fill of bundle.manifest.fills ?? []) {
    const value = checked("fill", JSON.parse(Buffer.from(bundle.files.get(fill.path)!).toString()));
    if (!value.at) continue;
    const event = events.find(e => eventId(e) === value.at);
    if (!event) throw new Error(`Fill names no run event: ${value.at}`);
    event.body = { inline: typeof value.value === "string" ? value.value : JSON.stringify(value.value) };
    event.provenance = value.tag;
  }
  return events;
}

export async function bundleBody(bundle: MomentBundle, event: TraceEvent): Promise<Uint8Array> {
  if (!event.body) return new Uint8Array();
  if ("inline" in event.body) return Buffer.from(event.body.inline);
  const bytes = bundle.files.get(`data/blobs/${event.body.blob.slice(7)}`);
  if (!bytes || digest(bytes) !== event.body.blob) throw new Error(`Missing or corrupt evidence blob: ${event.body.blob}`);
  return bytes;
}
