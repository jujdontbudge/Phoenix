import { mcpHttpShape, mcpShape, toCall } from "@phoenix/answer";
import { HTTP_STREAM, decodeHttpBody, decodeSse, encodeHttpHead, type HttpRequest, type Link } from "@phoenix/taps";
import type { Responder } from "./responder.ts";

const header = (headers: readonly string[], name: string): string | undefined => {
  for (let i = 0; i + 1 < headers.length; i += 2) if (headers[i]!.toLowerCase() === name) return headers[i + 1];
  return undefined;
};

function remapId(bytes: Uint8Array, id: unknown, recordedId: unknown, sse: boolean, subscription: boolean, token: unknown, recordedToken: unknown): Uint8Array {
  const replace = (text: string) => {
    const shape = mcpShape(Buffer.from(text));
    if (!shape) return text;
    const message = shape.message;
    let changed = false;
    if (id !== undefined && !message.method && JSON.stringify(message.id) === JSON.stringify(recordedId) && JSON.stringify(id) !== JSON.stringify(recordedId)) { message.id = id as string | number | null; changed = true; }
    const params = message.params as Record<string, unknown> | undefined;
    if (token !== undefined && message.method === "notifications/progress" && params && JSON.stringify(params.progressToken) === JSON.stringify(recordedToken) && JSON.stringify(token) !== JSON.stringify(recordedToken)) { params.progressToken = token; changed = true; }
    if (subscription) for (const value of [message.params, message.result]) {
      const meta = (value as { _meta?: Record<string, unknown> } | undefined)?._meta;
      const key = "io.modelcontextprotocol/subscriptionId";
      if (meta && id !== undefined && JSON.stringify(meta[key]) === JSON.stringify(recordedId) && JSON.stringify(id) !== JSON.stringify(recordedId)) { meta[key] = id; changed = true; }
    }
    return changed ? JSON.stringify(message) : text;
  };
  if (!sse) return Buffer.from(replace(Buffer.from(bytes).toString()));
  const decoded = decodeSse(bytes);
  if (!decoded.ok) throw new Error(decoded.why);
  const event = decoded.value[0];
  if (!event || replace(event.data) === event.data) return bytes;
  const text = Buffer.from(bytes).toString();
  let replaced = false;
  return Buffer.from(text.replace(/^data:[^\r\n]*(?:\r?\n|\r)?/gm, () => {
    if (replaced) return "";
    replaced = true;
    return `data: ${replace(event.data)}\n`;
  }));
}

export function mcpHttpResponder(options: Responder & {
  request: HttpRequest;
  ids: Map<string, string>;
  waitFor(ids: readonly string[]): Promise<boolean>;
}): Link {
  const { connector, stream, out, request, trace } = options;
  const parts: Uint8Array[] = [];
  let started = false, aborted = false;
  const run = async (wire: Uint8Array): Promise<void> => {
    const history = options.history();
    await trace.append(stream, { kind: "meta", surface: "mcp", connector, head: { ...request } });
    const decoded = decodeHttpBody(wire, request.headers);
    if (!decoded.ok) return options.diverge({ trigger: "lifecycle", detail: decoded.why });
    const body = decoded.value;
    const rpc = mcpShape(body)?.message;
    const identity = (id: unknown) => JSON.stringify([header(request.headers, "mcp-session-id") ?? null, id]);
    let normalized = body;
    if (rpc?.method === "notifications/cancelled") {
      const params = rpc.params as { requestId?: unknown } | undefined;
      const prior = params && options.ids.get(identity(params.requestId));
      if (prior !== undefined) normalized = Buffer.from(JSON.stringify({ ...rpc, params: { ...params, requestId: prior } }));
    }
    const shape = mcpHttpShape(request, normalized);
    await trace.append(stream, { kind: "call", surface: "mcp", connector, op: shape.op, body });
    const call = { ...toCall({ surface: "mcp", connector, ...shape, raw: { body, head: request } }, options.policy), history };
    const answer = await options.respond(call);
    if (!answer || aborted) return;
    if (answer.exchange?.request.head && JSON.stringify(shape.transport) !== JSON.stringify(mcpHttpShape(answer.exchange.request.head, answer.exchange.request.body).transport))
      return options.diverge({ trigger: "lifecycle", detail: `MCP HTTP protocol, session or cursor headers differ from the recording on ${connector}` });
    const raw = answer.raw;
    const recorded = answer.exchange && mcpShape(answer.exchange.request.body)?.message;
    if (rpc?.method && "id" in rpc) options.ids.set(identity(rpc.id), call.key);
    const responseHead = raw.head ?? (mcpShape(raw.body) ? { status: 200, headers: ["content-type", "application/json"] } : undefined);
    if (!responseHead) throw new Error("MCP HTTP answer has neither a response head nor a JSON-RPC envelope");
    const headers: string[] = [];
    for (let i = 0; i + 1 < responseHead.headers.length; i += 2) {
      const name = responseHead.headers[i]!;
      if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name.toLowerCase())) headers.push(name, responseHead.headers[i + 1]!);
    }
    const head = { ...responseHead, headers };
    await trace.append(stream, { kind: "meta", surface: "mcp", connector, head });
    const sse = header(headers, "content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    if (!raw.body.length && !sse) {
      await trace.append(stream, { kind: "result", surface: "mcp", connector, op: "frame:back:2", body: raw.body, provenance: answer.provenance, resolver: answer.resolver });
      out.push(HTTP_STREAM.responseHead, encodeHttpHead(head), true);
      out.push(HTTP_STREAM.responseBody, raw.body, true);
      out.end();
      return;
    }
    out.push(HTTP_STREAM.responseHead, encodeHttpHead(head), true);
    const actualId = rpc?.id;
    const recordedId = recorded?.id;
    const token = (rpc?.params as { _meta?: { progressToken?: unknown } } | undefined)?._meta?.progressToken;
    const recordedToken = (recorded?.params as { _meta?: { progressToken?: unknown } } | undefined)?._meta?.progressToken;
    const chunks = raw.chunks ?? [{ bytes: raw.body, waitFor: [] }];
    const sent: Uint8Array[] = [];
    const timing: { offset: number; at: string }[] = [];
    let offset = 0;
    for (const chunk of chunks) {
      if (aborted || !await options.waitFor(chunk.waitFor)) return;
      const bytes = remapId(chunk.bytes, actualId, recordedId, sse, rpc?.method === "subscriptions/listen", token, recordedToken);
      sent.push(bytes);
      timing.push({ offset, at: process.hrtime.bigint().toString() });
      offset += bytes.length;
      await trace.append(stream, { kind: "result", layer: "under", surface: "mcp", connector, op: "fragment:back:2", body: bytes, provenance: answer.provenance, resolver: answer.resolver });
      out.push(HTTP_STREAM.responseBody, bytes, false);
    }
    await trace.append(stream, { kind: "result", surface: "mcp", connector, op: "frame:back:2", body: Buffer.concat(sent), chunks: timing, provenance: answer.provenance, resolver: answer.resolver });
    out.push(HTTP_STREAM.responseBody, new Uint8Array(), true);
    out.end();
  };
  return {
    async write(f) {
      if (f.stream !== HTTP_STREAM.requestBody || started || aborted) return;
      parts.push(f.bytes);
      if (f.last) { started = true; void run(Buffer.concat(parts)).catch(error => { out.fail(error); return options.interrupt(error); }); }
    },
    frames: () => out.frames(),
    abort() { aborted = true; out.end(); },
  };
}
