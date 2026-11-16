import type { TraceEvent } from "@phoenix/formats";
import { decodeHttpHead, decodeJson, header, type HttpRequest, type Surface } from "@phoenix/wire";
import { httpShape, mcpShape, toCall } from "./normalize.ts";
import { cliRecording, cliShape } from "./cli.ts";
import { mcpHttpMessages, mcpHttpShape } from "./mcp-http.ts";
import type { CallMessage, ConnectorPolicy, Exchange, ExchangeIndex, Provenance, WireMessage } from "./types.ts";

const eventId = (e: TraceEvent): string => e.id ?? `${e.stream}:${e.seq}`;

interface Paired {
  call: TraceEvent;
  result: TraceEvent;
  surface: Surface;
  op: string;
  args: unknown;
  request: CallMessage;
  response: WireMessage;
  during: { message: Uint8Array; reply?: Uint8Array }[];
  after: Uint8Array[];
}

async function pairMcp(list: readonly TraceEvent[], body: (e: TraceEvent) => Promise<Uint8Array>, notifications: Set<string>): Promise<Paired[]> {
  const paired: Paired[] = [];
  let unsolicited: { message: Uint8Array; reply?: Uint8Array }[] = [];
  let previous: Paired | undefined;
  const open = new Map<string, Omit<Paired, "result" | "response" | "after">>();
  const order: Omit<Paired, "result" | "response" | "after">[] = [];
  const awaitingReply = new Map<string, { message: Uint8Array; reply?: Uint8Array }>();
  for (const event of list) {
    const bytes = await body(event);
    const shape = mcpShape(bytes);
    if (!shape || event.partial) continue;
    const { message } = shape;
    const id = JSON.stringify(message.id);
    if (event.kind === "call" && message.method && "id" in message) {
      const draft = { call: event, surface: "mcp" as const, op: shape.op!, args: shape.args, request: { body: bytes }, during: unsolicited };
      unsolicited = [];
      open.set(id, draft); order.push(draft);
    } else if (event.kind === "call" && message.method) {
      notifications.add(message.method);
    } else if (event.kind === "call" && !message.method && awaitingReply.has(id)) {
      awaitingReply.get(id)!.reply = bytes;
      awaitingReply.delete(id);
    } else if (event.kind === "result" && !message.method && open.has(id)) {
      const draft = open.get(id)!;
      open.delete(id);
      order.splice(order.indexOf(draft), 1);
      previous = { ...draft, result: event, response: { body: bytes }, after: [] };
      paired.push(previous);
    } else if (event.kind === "result" && message.method) {
      const during: { message: Uint8Array; reply?: Uint8Array } = { message: bytes };
      if (order.length) order.at(-1)!.during.push(during);
      else if (previous && !("id" in message)) previous.after.push(bytes);
      else unsolicited.push(during);
      if ("id" in message) awaitingReply.set(id, during);
    }
  }
  return paired;
}

async function pairHttp(list: readonly TraceEvent[], body: (e: TraceEvent) => Promise<Uint8Array>, surface: "http" | "mcp" = "http"): Promise<Paired[]> {
  const framed = list.some(e => e.op === "open");
  const call = list.find(e => framed ? e.op === "frame:out:0" : e.kind === "call");
  const result = list.find(e => framed ? e.op === "frame:back:2" : e.kind === "result" && e.op !== "fragment:back:2");
  const requestMeta = framed ? list.find(e => e.op === "open") : list.filter(e => e.kind === "meta")[0];
  const responseMeta = framed ? list.find(e => e.op === "frame:back:1") : list.filter(e => e.kind === "meta")[1];
  if (!call || !result || !requestMeta || !responseMeta || call.partial || result.partial) return [];
  const head = decodeJson(await body(requestMeta));
  if (!head.ok) return [];
  const request = { body: await body(call), head: (framed ? (head.value as { meta: { request: HttpRequest } }).meta.request : head.value) as HttpRequest,
    ...(call.body?.content_encoding ? { contentEncoding: call.body.content_encoding } : {}) };
  const shape = surface === "mcp" ? mcpHttpShape(request.head, request.body) : httpShape(request.head, request.body);
  const encoding = result.body?.content_encoding;
  const response = { body: await body(result), head: decodeHttpHead(await body(responseMeta)), ...(encoding ? { contentEncoding: encoding } : {}) };
  return [{
    call, result, surface, op: shape.op, args: shape.args, request, during: [], after: [],
    response,
  }];
}

export async function buildIndex(events: readonly TraceEvent[], options: {
  body(event: TraceEvent): Promise<Uint8Array>;
  policy(connector: string): ConnectorPolicy;
  startTime?: string;
}): Promise<ExchangeIndex> {
  const streams = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (!event.surface || !event.connector || !["call", "result", "meta"].includes(event.kind)) continue;
    streams.set(event.stream, [...streams.get(event.stream) ?? [], event]);
  }
  const paired: Paired[] = [];
  const notifications = new Map<string, Set<string>>();
  for (const list of streams.values()) {
    const connector = list[0]!.connector!;
    if (!notifications.has(connector)) notifications.set(connector, new Set());
    if (list[0]!.surface === "mcp") {
      const open = list.find(e => e.op === "open");
      const meta = open && decodeJson(await options.body(open));
      const http = meta && meta.ok && (meta.value as { meta?: { transport?: string } }).meta?.transport === "http";
      const head = list.find(e => e.kind === "meta" && e.op !== "open" && e.body);
      const decoded = !http && head && decodeJson(await options.body(head));
      if (http || decoded && decoded.ok && typeof (decoded.value as { method?: unknown }).method === "string") paired.push(...await pairHttp(list, options.body, "mcp"));
      else paired.push(...await pairMcp(list, options.body, notifications.get(connector)!));
    }
    else if (list[0]!.surface === "http") paired.push(...await pairHttp(list, options.body, "http"));
    else if (list[0]!.surface === "cli") {
      const cli = await cliRecording(list, options.body);
      if (cli) paired.push({ ...cli, surface: "cli", ...cliShape(cli.invocation), request: { body: Buffer.from(JSON.stringify(cli.invocation)) }, response: { body: Buffer.from(JSON.stringify(cli.frames)) }, during: [], after: [] });
    }
  }
  const position = new Map(events.map((e, i) => [e, i] as const));
  const requestKeys = new Map<string, string>();
  for (const p of [...paired].sort((a, b) => position.get(a.call)! - position.get(b.call)!)) {
    if (p.surface !== "mcp" || !p.request.head) continue;
    const rpc = mcpShape(p.request.body)?.message;
    const identity = (id: unknown) => JSON.stringify([p.call.connector, header(p.request.head!.headers, "mcp-session-id") ?? null, id]);
    if (rpc?.method === "notifications/cancelled") {
      const params = rpc.params as { requestId?: unknown } | undefined;
      const key = params && requestKeys.get(identity(params.requestId));
      if (key) p.args = mcpHttpShape(p.request.head, Buffer.from(JSON.stringify({ ...rpc, params: { ...params, requestId: key } }))).args;
    }
    if (rpc?.method && "id" in rpc) requestKeys.set(identity(rpc.id), toCall({ surface: p.surface, connector: p.call.connector!, op: p.op, args: p.args, raw: p.request }, options.policy(p.call.connector!)).key);
  }
  for (const p of paired.filter(p => p.surface === "mcp" && p.request.head)) {
    const bytes = p.response.body;
    const blocks = mcpHttpMessages(bytes, header(p.response.head!.headers, "content-type") ?? "");
    blocks.push({ bytes: new Uint8Array(), offset: bytes.length });
    p.response.chunks = blocks.map(block => {
      const end = block.offset + Math.max(0, block.bytes.length - 1);
      const at = p.result.chunks?.findLast(c => c.offset <= end)?.at ?? p.result.ts.mono;
      const before = (other: Paired) => at && other.call.ts.mono ? BigInt(other.call.ts.mono) <= BigInt(at) : position.get(other.call)! < position.get(p.result)!;
      return { bytes: block.bytes, waitFor: paired.filter(other => other !== p && other.surface === "mcp" && other.call.connector === p.call.connector && other.request.head && before(other)).map(other => eventId(other.call)) };
    });
  }
  const drafts = paired.map(p => {
    const call = toCall({ surface: p.surface, layer: p.call.layer, connector: p.call.connector!, op: p.op, args: p.args, raw: p.request }, options.policy(p.call.connector!));
    return { p, call, position: position.get(p.call)!, completed: position.get(p.result)! };
  }).sort((a, b) => a.position - b.position);
  const writes = drafts.filter(d => !d.call.readOnly).sort((a, b) => a.completed - b.completed);
  const exchanges: Exchange[] = drafts.map(({ p, call, position, completed }) => ({
    id: eventId(p.call), surface: call.surface, layer: call.layer, connector: call.connector, op: call.op, args: call.args, key: call.key, readOnly: call.readOnly,
    history: writes.filter(w => w.call.connector === call.connector && w.completed < position).map(w => w.call.key),
    frozen: false, position, completed, observedAt: p.result.ts.wall,
    provenance: (p.result.provenance === "derived" || p.result.provenance === "synthesized" ? p.result.provenance : "recorded") as Provenance,
    request: p.request, response: p.response, during: p.during, after: p.after,
  }));
  const startTime = options.startTime ?? events[0]?.ts.wall ?? new Date(0).toISOString();
  const prefetch: Exchange[] = [];
  for (const [position, event] of events.entries()) {
    if (event.kind !== "prefetch" || event.partial || !event.connector || !event.surface) continue;
    const decoded = decodeJson(await options.body(event));
    if (!decoded.ok || !decoded.value || typeof decoded.value !== "object") continue;
    const data = decoded.value as { op?: string; args?: unknown; request?: { body: string; body_encoding?: "base64"; head?: HttpRequest }; response?: { body: string; body_encoding?: "base64"; contentEncoding?: string; head?: import("@phoenix/wire").HttpResponse } };
    if (typeof data.op !== "string" || typeof data.request?.body !== "string" || typeof data.response?.body !== "string") continue;
    const request = { ...data.request, body: Buffer.from(data.request.body, data.request.body_encoding === "base64" ? "base64" : "utf8") };
    const call = toCall({ surface: event.surface, connector: event.connector, op: data.op, args: data.args, raw: request }, options.policy(event.connector));
    if (!call.readOnly) continue;
    prefetch.push({ ...call, id: eventId(event), request, response: { ...data.response, body: Buffer.from(data.response.body, data.response.body_encoding === "base64" ? "base64" : "utf8") },
      history: writes.filter(w => w.call.connector === call.connector && w.completed < position).map(w => w.call.key),
      frozen: false, position, completed: position, observedAt: event.ts.wall, provenance: "recorded", during: [], after: [],
    });
  }
  return {
    exchanges, prefetch, frozen: [], continuation: exchanges, notifications, startTime, cutTime: startTime,
  };
}
