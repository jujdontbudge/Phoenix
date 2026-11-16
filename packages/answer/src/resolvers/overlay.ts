import { canonicalJson, sameWriteHistory } from "@phoenix/wire";
import type { PluginDescriptor } from "@phoenix/formats";
import type { Call, Exchange, ReplayCtx, Resolver, WireMessage } from "../types.ts";

type MapEntry = NonNullable<PluginDescriptor["entity_map"]>[string];
type Collection = { entities: Map<string, unknown>; unknown: Set<string>; complete: boolean; uncertain: boolean };
type State = { collections: Map<string, Collection>; writes: Map<string, Call> };
const states = new WeakMap<ReplayCtx, Map<string, State>>();

function path(value: unknown, pointer = ""): unknown {
  if (!pointer) return value;
  if (!pointer.startsWith("/")) return undefined;
  for (const key of pointer.slice(1).split("/").map(k => k.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function put(pointer: string | undefined, value: unknown): unknown {
  if (!pointer) return value;
  if (!pointer.startsWith("/")) throw new Error("Entity paths must be JSON Pointers");
  const keys = pointer.slice(1).split("/").map(k => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  let result = value;
  for (const key of keys.reverse()) result = { [key]: result };
  return result;
}

function declaredArguments(value: unknown, pointers: readonly string[], prefix = ""): boolean {
  if (pointers.includes(prefix)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, child]) => {
    const pointer = `${prefix}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    return pointers.some(p => p === pointer || p.startsWith(`${pointer}/`)) && declaredArguments(child, pointers, pointer);
  });
}

function payload(raw: WireMessage, surface: string): { value: unknown; encode(value: unknown): WireMessage } | undefined {
  if (raw.contentEncoding) return;
  try {
    const envelope = JSON.parse(Buffer.from(raw.body).toString());
    if (surface !== "mcp") {
      if (!raw.head || raw.head.status < 200 || raw.head.status >= 300) return;
      return { value: envelope, encode: value => ({ ...raw, body: Buffer.from(JSON.stringify(value)), head: { ...raw.head!, headers: raw.head!.headers.filter((_, i, a) => a[i - i % 2]!.toLowerCase() !== "content-length") } }) };
    }
    if (envelope.error || !envelope.result || envelope.result.isError) return;
    const result = envelope.result;
    const text = result.content?.length === 1 && result.content[0].type === "text" ? result.content[0].text : undefined;
    if (result.structuredContent === undefined && typeof text !== "string") return;
    const value = result.structuredContent ?? (typeof text === "string" ? JSON.parse(text) : result);
    return { value, encode: value => ({ body: Buffer.from(JSON.stringify({ ...envelope, result: result.structuredContent !== undefined
      ? { ...result, structuredContent: value, ...(text !== undefined ? { content: [{ type: "text", text: JSON.stringify(value) }] } : {}) }
      : text !== undefined ? { ...result, content: [{ type: "text", text: JSON.stringify(value) }] } : value }) + "\n") }) };
  } catch { return; }
}

function collection(state: State, entity: string): Collection {
  let found = state.collections.get(entity);
  if (!found) { found = { entities: new Map(), unknown: new Set(), complete: false, uncertain: false }; state.collections.set(entity, found); }
  return found;
}

function absorb(state: State, map: MapEntry, call: Pick<Call, "args" | "surface" | "readOnly">, raw: WireMessage): void {
  const data = payload(raw, call.surface);
  const c = collection(state, map.entity);
  const id = path(call.args, map.id_path);
  const items = data ? path(data.value, map.items_path) : undefined;
  if (!call.readOnly) {
    if (map.kind !== "create" && typeof id !== "string") { c.entities.clear(); c.complete = false; c.uncertain = true; }
    if (map.kind === "create" || typeof id !== "string") {
      if (typeof path(items, map.id_path) !== "string") { c.complete = false; c.uncertain = true; }
    }
    else { c.entities.delete(id); c.unknown.add(id); }
  }
  if (!data) return;
  if (map.kind === "delete") {
    if (typeof id === "string") { c.entities.delete(id); c.unknown.delete(id); }
    return;
  }
  if (map.kind === "list") {
    if (!Array.isArray(items)) return;
    const complete = (map.complete === "unpaginated" || (map.complete !== undefined && path(data.value, map.complete) === true))
      && Object.keys(call.args as object ?? {}).length === 0;
    if (complete) { c.entities.clear(); c.unknown.clear(); c.complete = true; c.uncertain = false; }
    for (const item of items) {
      const key = path(item, map.id_path);
      if (typeof key === "string") { c.entities.set(key, item); c.unknown.delete(key); }
    }
  } else {
    const key = path(items, map.id_path);
    if (typeof key === "string") { c.entities.set(key, items); c.unknown.delete(key); }
  }
}

function stateFor(ctx: ReplayCtx, connector: string): State {
  let connectors = states.get(ctx);
  if (!connectors) { connectors = new Map(); states.set(ctx, connectors); }
  let state = connectors.get(connector);
  if (state) return state;
  state = { collections: new Map(), writes: new Map() };
  connectors.set(connector, state);
  const maps = ctx.policy(connector).entity_map ?? {};
  const frozen = ctx.index.frozen.filter(e => e.connector === connector).sort((a, b) => a.completed - b.completed);
  const history = frozen.filter(e => !e.readOnly).map(e => e.key);
  const observations = [...frozen, ...(ctx.index.prefetch ?? []).filter(e => e.connector === connector && sameWriteHistory(e.history, history))].sort((a, b) => a.completed - b.completed);
  for (const e of observations) {
    if (maps[e.op] && (e.provenance !== "synthesized" || !e.readOnly)) absorb(state, maps[e.op]!, e, e.provenance === "synthesized" ? { body: new Uint8Array() } : e.response);
    else if (!e.readOnly) for (const c of state.collections.values()) { c.entities.clear(); c.complete = false; c.uncertain = true; }
  }
  return state;
}

function emulatorOwns(ctx: ReplayCtx, connector: string): boolean {
  return ctx.emulators?.has(connector) ?? false;
}

export function entityCurrent(exchange: Exchange, call: Call, ctx: ReplayCtx): boolean {
  const history = call.history ?? ctx.histories[call.connector] ?? [];
  if (sameWriteHistory(exchange.history, history)) return true;
  const maps = ctx.policy(call.connector).entity_map;
  const map = maps?.[call.op];
  if (!maps || !map || !call.readOnly || emulatorOwns(ctx, call.connector)) return false;
  const state = stateFor(ctx, call.connector);
  let shared = 0;
  while (shared < history.length && history[shared] === exchange.history[shared]) shared++;
  for (const key of [...history.slice(shared), ...exchange.history.slice(shared)]) {
    const write = state.writes.get(key) ?? ctx.index.exchanges.find(e => e.connector === call.connector && e.key === key);
    const effect = write && maps[write.op];
    if (!write || !effect) return false;
    if (effect.entity !== map.entity) continue;
    if (effect.kind === "create" || map.kind === "list") return false;
    const touched = path(write.args, effect.id_path);
    if (typeof touched !== "string" || touched === path(call.args, map.id_path)) return false;
  }
  return true;
}

export const overlay: Resolver = {
  name: "overlay",
  observe(call, answer, ctx) {
    const maps = ctx.policy(call.connector).entity_map;
    if (!maps || emulatorOwns(ctx, call.connector)) return;
    const state = stateFor(ctx, call.connector);
    if (!call.readOnly) state.writes.set(call.key, call);
    const map = maps[call.op];
    if (map && (answer.provenance !== "synthesized" || !call.readOnly)) absorb(state, map, call, answer.provenance === "synthesized" ? { body: new Uint8Array() } : answer.raw);
    else if (!call.readOnly) for (const c of state.collections.values()) { c.entities.clear(); c.complete = false; c.uncertain = true; }
  },
  async resolve(call, ctx) {
    const policy = ctx.policy(call.connector), map = policy.entity_map?.[call.op];
    if (!map || emulatorOwns(ctx, call.connector)) return { miss: true, why: "no overlay owns this operation" };
    if (!call.readOnly || policy.volatile?.includes(call.op) || !["get", "list"].includes(map.kind)) return { miss: true, why: "overlay only derives non-volatile reads" };
    const c = collection(stateFor(ctx, call.connector), map.entity);
    let value: unknown;
    if (map.kind === "get") {
      const id = path(call.args, map.id_path);
      if (typeof id !== "string" || c.unknown.has(id)) return { miss: true, why: "entity state is unknown" };
      if (!c.entities.has(id) && !c.complete) return { miss: true, why: "entity was never observed" };
      value = c.entities.get(id) ?? null;
    } else {
      if (!c.complete || c.unknown.size || c.uncertain) return { miss: true, why: "collection is not completely known" };
      const args = call.args as Record<string, unknown>;
      if (!args || typeof args !== "object" || Array.isArray(args) || !declaredArguments(args, (map.filters ?? []).map(f => f.arg))) return { miss: true, why: "undeclared list filter" };
      if (map.filters?.some(f => {
        const bounds = path(args, f.arg);
        return f.match === "range" && bounds !== undefined && (!Array.isArray(bounds) || bounds.length !== 2 || !["string", "number"].includes(typeof bounds[0]) || typeof bounds[0] !== typeof bounds[1] || bounds[0] > bounds[1]);
      })) return { miss: true, why: "range filters require inclusive [minimum, maximum] bounds" };
      value = [...c.entities.values()].filter(item => (map.filters ?? []).every(filter => {
        const wanted = path(args, filter.arg);
        if (wanted === undefined) return true;
        const actual = path(item, filter.field);
        if (filter.match === "equality") return actual !== undefined && canonicalJson(actual) === canonicalJson(wanted);
        if (!Array.isArray(wanted) || wanted.length !== 2 || (typeof actual !== "number" && typeof actual !== "string")) return false;
        return typeof wanted[0] === typeof actual && typeof wanted[1] === typeof actual && actual >= wanted[0] && actual <= wanted[1];
      }));
    }
    const templates = [...ctx.index.exchanges, ...(ctx.index.prefetch ?? [])].filter(e => e.connector === call.connector && e.surface === call.surface && e.provenance !== "synthesized" && (e.surface !== "mcp" || e.op.startsWith("tools/call:")) && payload(e.response, e.surface));
    const template = templates.find(e => e.op === call.op) ?? templates[0];
    const decoded = template && payload(template.response, call.surface);
    if (!decoded || (map.items_path && !map.items_path.startsWith("/"))) return { miss: true, why: "no usable response template for this operation" };
    return { raw: decoded.encode(put(map.items_path, value)), provenance: "derived", resolver: "overlay", note: "entity map over captured observations and replay writes" };
  },
};
