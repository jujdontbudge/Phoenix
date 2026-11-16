import type { TraceEvent } from "@phoenix/formats";
import { decodeCliInvocation, decodeHttpBody, decodeJson, decodeMcp, mcpInfo, object, type RpcMessage, type Surface } from "@phoenix/wire";

export type Body = (event: TraceEvent) => Promise<Uint8Array | undefined>;
export const eventId = (e: TraceEvent): string => e.id ?? `${e.stream}:${e.seq}`;

export interface McpCall { connector: string; call: TraceEvent; request: RpcMessage; op: string; result?: { event: TraceEvent; message: RpcMessage }; text?: { event: TraceEvent; text: string } }
export interface CliCall { connector: string; event: TraceEvent; argv: string[] }
export interface HttpCall { connector: string; method: string; op: string; response?: { status: number; body?: unknown } }

export interface RunEvidence {
  surfaces: Map<string, { surface: Surface; routes: Set<string> }>;
  mcp: McpCall[];
  initialize: Map<string, RpcMessage>;
  toolLists: Map<string, unknown[]>;
  cli: CliCall[];
  http: HttpCall[];
}

const json = (bytes: Uint8Array | undefined): unknown => {
  if (!bytes) return undefined;
  const decoded = decodeJson(bytes);
  return decoded.ok ? decoded.value : undefined;
};

const header = (headers: readonly string[], name: string) => headers.find((_, i) => i % 2 === 1 && headers[i - 1]!.toLowerCase() === name);

export async function readEvidence(events: readonly TraceEvent[], body: Body): Promise<RunEvidence> {
  const evidence: RunEvidence = { surfaces: new Map(), mcp: [], initialize: new Map(), toolLists: new Map(), cli: [], http: [] };
  const streams = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (!e.connector || !e.surface || e.layer === "under") continue;
    const seen = evidence.surfaces.get(e.connector) ?? { surface: e.surface, routes: new Set<string>() };
    seen.routes.add(e.route ?? "tap");
    evidence.surfaces.set(e.connector, seen);
    streams.set(e.stream, [...streams.get(e.stream) ?? [], e]);
  }
  for (const list of streams.values()) {
    const connector = list[0]!.connector!, surface = list[0]!.surface!;
    if (surface === "mcp") {
      const open = new Map<string, McpCall>();
      for (const e of list) {
        if (e.kind !== "call" && e.kind !== "result") continue;
        const bytes = (await body(e)) ?? new Uint8Array(), decoded = decodeMcp(bytes);
        if (!decoded.ok) {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          if (e.kind === "result" && e.route !== "tap" && !e.partial && e.body && open.size === 1) {
            const call = [...open.values()][0]!;
            open.clear();
            call.text = { event: e, text };
          }
          continue;
        }
        const message = decoded.value, id = JSON.stringify(message.id);
        if (e.kind === "call" && message.method && "id" in message) {
          const call: McpCall = { connector, call: e, request: message, op: mcpInfo(message).op! };
          open.set(id, call); evidence.mcp.push(call);
        } else if (e.kind === "result" && !message.method && open.has(id)) {
          const call = open.get(id)!;
          open.delete(id);
          if (e.partial || call.call.partial) continue;
          call.result = { event: e, message };
          const result = object(message.result);
          if (call.op === "initialize" && message.result) evidence.initialize.set(connector, message);
          if (call.op === "tools/list" && Array.isArray(result.tools)) evidence.toolLists.set(connector, [...evidence.toolLists.get(connector) ?? [], ...result.tools]);
        }
      }
      continue;
    }
    const opened = list.find(e => e.kind === "meta" && e.op === "open");
    const meta = object(object(json(opened && await body(opened))).meta);
    if (surface === "cli") {
      try { evidence.cli.push({ connector, event: opened!, argv: decodeCliInvocation(new TextEncoder().encode(JSON.stringify(meta))).argv }); } catch {}
      continue;
    }
    const call = list.find(e => e.kind === "call" && !e.partial);
    const result = list.find(e => e.kind === "result" && !e.partial);
    const head = object(json(await (async () => { const e = list.find(e => e.kind === "meta" && e.op?.startsWith("frame:back:")); return e && body(e); })()));
    const headers = Array.isArray(head.headers) ? head.headers as string[] : [];
    let responseBody = result ? await body(result) : undefined;
    if (responseBody && !result!.body?.content_encoding) {
      const decoded = decodeHttpBody(responseBody, headers);
      responseBody = decoded.ok ? decoded.value : undefined;
    }
    const request = object(meta.request), requestHeaders = Array.isArray(request.headers) ? request.headers as string[] : [];
    const method = String(request.method ?? "GET").toUpperCase(), url = new URL(String(request.url ?? "/"), "http://x");
    const host = (header(requestHeaders, "host") ?? "").replace(/:(80|443)$/, "").toLowerCase();
    evidence.http.push({
      connector, method, op: `${method} ${host}${url.pathname}`,
      ...(typeof head.status === "number" ? { response: { status: head.status, ...(json(responseBody) !== undefined ? { body: json(responseBody) } : {}) } } : {}),
    });
  }
  return evidence;
}
