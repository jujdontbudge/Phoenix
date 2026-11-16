import { validate, type TraceEvent, type ReplayResult } from "@phoenix/formats";
import { decodeMcpHttp, object } from "@phoenix/wire";

export type Tier = NonNullable<ReplayResult["fidelity_grade"]>;
export interface ConnectorContext {
  plugin_tier?: Tier;
  coverage_tier: Tier;
  origin: "captured" | "seeded";
  routes: string[];
  read_only?: { op: string; source: string }[];
}
export interface FidelityContext {
  source: "snapshot" | "scenario";
  connectors: Record<string, ConnectorContext>;
  start: ReplayResult["start"];
  container_runtime: string;
  clock: unknown;
  processes: { path: string; clock: "virtual" | "real" | "unknown" }[];
  earlier_tasks_not_replayed?: boolean;
}

export interface ReportItem { event: string; connector?: string; call?: string; detail?: unknown }
export interface ConnectorReport {
  connector: string;
  called: boolean;
  tier: Tier;
  origin?: ConnectorContext["origin"];
  routes: string[];
  responses: Record<NonNullable<TraceEvent["provenance"]>, number>;
}
export interface FidelityReport {
  context?: FidelityContext;
  grade?: Tier;
  connectors: ConnectorReport[];
  unused: string[];
  answers: ReportItem[];
  unverified_read_only: ReportItem[];
  stale: ReportItem[];
  divergences: ReportItem[];
  emulator_differences: ReportItem[];
  format_mismatches: ReportItem[];
  local_file_effects: ReportItem[];
  workdir: ReportItem[];
  gaps: ReportItem[];
  unattributed: ReportItem[];
  secrets: ReportItem[];
  discounts: ReportItem[];
  notes: string[];
}

const tiers: Tier[] = ["blocked", "synthesized", "recorded", "stateful"];
export function weakestTier(...values: Tier[]): Tier {
  if (!values.length || values.some(v => !tiers.includes(v))) throw new Error("Expected a fidelity tier");
  return tiers[Math.min(...values.map(v => tiers.indexOf(v)))]!;
}

export function responseTier(event: Pick<TraceEvent, "kind" | "provenance" | "resolver">): Tier {
  if (event.kind === "divergence" || event.resolver === "blocked") return "blocked";
  if (event.provenance === "synthesized" || event.resolver === "simulator") return "synthesized";
  if (event.resolver === "emulator") return "stateful";
  if (event.provenance === "derived" || event.provenance === "recorded") return "recorded";
  return "recorded";
}

export function fidelityReport(trace: readonly TraceEvent[], blobs: Readonly<Record<string, string>> = {}): FidelityReport {
  const report: FidelityReport = { connectors: [], unused: [], answers: [], unverified_read_only: [], stale: [], divergences: [], emulator_differences: [], format_mismatches: [], local_file_effects: [], workdir: [], gaps: [], unattributed: [], secrets: [], discounts: [], notes: [] };
  const connectors = new Map<string, ConnectorReport>();
  const lastCall = new Map<string, string>();
  const rpcCalls = new Map<string, string>();
  const text = (event: TraceEvent): string => {
    const text = event.body && ("inline" in event.body ? event.body.inline : blobs[event.body.blob]);
    if (text === undefined) throw new Error(`Missing fidelity metadata body: ${event.id ?? event.stream}`);
    return text;
  };
  const body = (event: TraceEvent): unknown => JSON.parse(text(event));
  for (const event of trace) {
    const valid = validate("trace", event);
    if (!valid.ok) throw new Error(valid.errors.join("; "));
    if (event.kind === "meta" && event.op === "fidelity.context") {
      if (report.context) throw new Error("Duplicate fidelity context");
      const value = object(body(event));
      if (!["snapshot", "scenario"].includes(value.source as string) || !value.connectors || typeof value.connectors !== "object" || !value.start || typeof value.container_runtime !== "string" || !Array.isArray(value.processes)) throw new Error("Invalid fidelity context");
      const context = value as unknown as FidelityContext;
      for (const [name, c] of Object.entries(context.connectors)) {
        const tier = weakestTier(c.plugin_tier ?? "recorded", c.coverage_tier);
        if (!["captured", "seeded"].includes(c.origin) || !Array.isArray(c.routes)) throw new Error(`Invalid connector context: ${name}`);
        connectors.set(name, { connector: name, called: false, tier, origin: c.origin, routes: c.routes, responses: { real: 0, recorded: 0, derived: 0, synthesized: 0, seeded: 0 } });
        for (const rule of c.read_only ?? []) if (rule.source !== "plugin") report.unverified_read_only.push({ event: event.id ?? `${event.stream}:${event.seq}`, connector: name, detail: rule });
      }
      report.context = context;
    }
  }
  if (!report.context) report.notes.push("No fidelity.context event; connector ceilings and run context are unavailable, so undeclared connectors are capped at recorded");
  const categories = ["unverified_read_only", "stale", "emulator_differences", "format_mismatches", "local_file_effects", "workdir", "gaps", "unattributed", "discounts", "answers"] as const;
  for (const event of trace) {
    const id = event.id ?? `${event.stream}:${event.seq}`;
    const item: ReportItem = { event: id, ...(event.connector ? { connector: event.connector } : {}) };
    if (event.kind === "meta") {
      const category = categories.find(c => event.op === `fidelity.${c}`);
      if (category) report[category].push({ ...item, detail: body(event) });
    }
    if (event.kind === "gap" || event.dropped || event.partial) report.gaps.push({ ...item, detail: { kind: event.kind, dropped: event.dropped, partial: event.partial } });
    if (event.secrets === "unscanned" || event.secrets?.length) report.secrets.push({ ...item, detail: event.secrets });
    if (event.kind === "divergence") report.divergences.push({ ...item, detail: event.body ? body(event) : event.op });
    if (!event.connector || event.layer === "under") continue;
    if (!["call", "result", "divergence"].includes(event.kind)) continue;
    let connector = connectors.get(event.connector);
    if (!connector) {
      connector = { connector: event.connector, called: false, tier: "recorded", routes: [], responses: { real: 0, recorded: 0, derived: 0, synthesized: 0, seeded: 0 } };
      connectors.set(event.connector, connector);
    }
    connector.called = true;
    const key = `${event.connector}:${event.stream}`;
    let rpcKey: string | undefined;
    if (event.surface === "mcp") {
      try {
        const value = text(event);
        const bytes = new TextEncoder().encode(value);
        const json = decodeMcpHttp(bytes, "application/json");
        const decoded = json.some(d => d.ok) ? json : decodeMcpHttp(bytes, "text/event-stream");
        const rpc = decoded.find(d => d.ok && (event.kind === "call" ? d.value.method === "tools/call" : "result" in d.value || "error" in d.value));
        if (rpc?.ok && (typeof rpc.value.id === "string" || typeof rpc.value.id === "number")) rpcKey = JSON.stringify([event.connector, event.stream, rpc.value.id]);
      } catch { report.notes.push(`Cannot correlate MCP response evidence at ${id}`); }
    }
    if (event.kind === "call") lastCall.set(key, id);
    if (event.kind === "call" && rpcKey !== undefined) rpcCalls.set(rpcKey, id);
    if (event.kind === "result") {
      if (event.provenance) connector.responses[event.provenance]++;
      else report.notes.push(`Response ${id} has no provenance`);
      const call = event.surface === "mcp" ? rpcKey === undefined ? undefined : rpcCalls.get(rpcKey) : lastCall.get(key);
      if (["derived", "synthesized", "seeded"].includes(event.provenance ?? "") || /fill|repeat/.test(event.resolver ?? "")) report.answers.push({ ...item, call, detail: { provenance: event.provenance, resolver: event.resolver } });
      if (rpcKey !== undefined) rpcCalls.delete(rpcKey);
    }
    if (event.kind !== "call") connector.tier = weakestTier(connector.tier, responseTier(event));
  }
  report.connectors = [...connectors.values()];
  report.unused = report.connectors.filter(c => !c.called).map(c => c.connector);
  const called = report.connectors.filter(c => c.called);
  if (called.length) report.grade = weakestTier(...called.map(c => c.tier));
  return report;
}
