import type { Server } from "node:http";
import { PassThrough, type Duplex } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import type { MomentManifest, PluginDescriptor, TraceEvent } from "@phoenix/formats";
import {
  answerCall, buildIndex, httpHost, httpShape, mcpShape, replayCtx, sameReply, toCall,
  Emulators, type EmulatorConfig, type Answer, type Call, type ConnectorPolicy, type Divergence, type SimulatorOptions, type WireMessage,
} from "@phoenix/answer";
import type { CaptureMetadata } from "@phoenix/store";
import { HTTP_STREAM, decodeCliInvocation, encodeHttpHead, httpTap, mcpStdioTap, type Backend, type HttpRequest, type Link } from "@phoenix/taps";
import { VirtualClock } from "./clock.ts";
import { SampleTrace, streamName } from "./trace.ts";
import { cliRelay, cliResponder } from "./cli.ts";
import { mcpHttpResponder } from "./mcp-http.ts";
import { Outbox, type Responder } from "./responder.ts";

export interface EngineOptions {
  emulators?: readonly EmulatorConfig[];
  simulator?: Omit<SimulatorOptions, "clock">;
  evidence: { events: readonly TraceEvent[]; body(event: TraceEvent): Promise<Uint8Array> };
  connectors?: MomentManifest["connectors"];
  volatile?: Readonly<Record<string, readonly string[]>>;
  entityMaps?: Readonly<Record<string, PluginDescriptor["entity_map"]>>;
  clock?: { start?: string };
  routes: { mcp?: Readonly<Record<string, string>>; cli?: Readonly<Record<string, string>>; http?: Readonly<Record<string, string>>; mcpHttp?: Readonly<Record<string, string>> };
  sample: { root: string; metadata: CaptureMetadata };
  hmacKey: Uint8Array;
}

export type EngineStop = { kind: "diverged"; divergence: Divergence } | { kind: "interrupted"; why: string };

export interface Engine {
  state(connector: string): Promise<unknown>;
  backend: Backend;
  http: Server;
  clock: VirtualClock;
  accept(connection: { destination: { host: string; port: number }; stream: Duplex }): void;
  stopped: Promise<EngineStop>;
  close(): Promise<void>;
}

const concat = (parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const header = (headers: readonly string[], name: string): string | undefined => {
  for (let i = 0; i + 1 < headers.length; i += 2) if (headers[i]!.toLowerCase() === name) return headers[i + 1];
  return undefined;
};

function encodeBody(bytes: Uint8Array, encoding: string | undefined): Uint8Array {
  let body = bytes;
  for (const e of (encoding ?? "identity").split(",").map(v => v.trim().toLowerCase())) {
    if (e === "gzip") body = gzipSync(body);
    else if (e === "deflate") body = deflateSync(body);
    else if (e === "br") body = brotliCompressSync(body);
    else if (e === "zstd") body = zstdCompressSync(body);
  }
  return body;
}

function withId(bytes: Uint8Array, id: unknown): Uint8Array {
  const message = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  if (JSON.stringify(message.id) === JSON.stringify(id)) return bytes;
  return Buffer.from(JSON.stringify({ ...message, id }) + "\n");
}

export async function startEngine(options: EngineOptions): Promise<Engine> {
  const policy = (connector: string): ConnectorPolicy => ({ ...options.connectors?.[connector], entity_map: options.entityMaps?.[connector], ...(options.volatile?.[connector] ? { volatile: options.volatile[connector] } : {}) });
  const index = await buildIndex(options.evidence.events, { body: options.evidence.body, policy, ...(options.clock?.start ? { startTime: options.clock.start } : {}) });
  const clock = new VirtualClock(index.startTime);
  const trace = await SampleTrace.create(options.sample.root, options.sample.metadata, clock, options.hmacKey);
  let emulators: Emulators;
  try {
    emulators = await Emulators.start((options.emulators ?? []).filter(c => !policy(c.plugin.descriptor.connector).skip_resolvers?.includes("emulator")), () => clock.now(), async difference => {
      await trace.append("engine", { kind: "meta", connector: difference.connector, op: "fidelity.emulator_differences", body: Buffer.from(JSON.stringify(difference)) });
    });
  } catch (error) { await trace.close(); throw error; }
  const ctx = replayCtx(index, policy, emulators, options.simulator ? { ...options.simulator, clock: () => index.cutTime } : undefined);
  const links = new Set<Outbox>();
  let linkCount = 0;
  const changed = new Set<() => void>();
  const mcpHttpIds = new Map<string, Map<string, string>>();
  let stop: EngineStop | undefined;
  let settle!: (value: EngineStop) => void;
  const stopped = new Promise<EngineStop>(resolve => { settle = resolve; });

  const halt = async (result: EngineStop): Promise<void> => {
    if (stop) return;
    stop = result;
    if (result.kind === "diverged")
      await trace.append("engine", { kind: "divergence", body: Buffer.from(JSON.stringify(result.divergence)), ...(result.divergence.call ? { connector: result.divergence.call.connector, op: result.divergence.call.op } : {}) }).catch(() => {});
    for (const link of links) link.fail(new Error(result.kind === "diverged" ? "Replay diverged" : "Replay interrupted"));
    for (const wake of changed) wake();
    settle(result);
  };
  const diverge = (divergence: Divergence) => halt({ kind: "diverged", divergence });
  const interrupt = (error: unknown) => halt({ kind: "interrupted", why: error instanceof Error ? error.message : String(error) });

  const respond = async (call: Call): Promise<Answer | undefined> => {
    if (stop) return undefined;
    const result = await answerCall(call, ctx);
    if ("divergence" in result) { await diverge(result.divergence); return undefined; }
    for (const wake of changed) wake();
    return result.answer;
  };

  const opened = (): Outbox => {
    const out = new Outbox();
    links.add(out);
    if (stop) out.fail(new Error("Replay stopped"));
    return out;
  };

  const responder = (surface: string, connector: string): Responder => ({
    connector, stream: streamName(surface, connector, String(linkCount++)), out: opened(), trace, policy: policy(connector),
    history: () => ctx.histories[connector] ?? [], respond, diverge, interrupt,
  });
  const waitFor = async (ids: readonly string[]): Promise<boolean> => {
    while (!stop && !ids.every(id => ctx.served.has(id))) await new Promise<void>(resolve => {
      const wake = () => { changed.delete(wake); resolve(); };
      changed.add(wake);
    });
    return !stop;
  };

  const mcpLink = (connector: string): Link => {
    const out = opened();
    const stream = streamName("mcp", connector, String(linkCount++));
    const parts = new Map<number, Uint8Array[]>();
    const replies = new Map<string, (bytes: Uint8Array) => void>();
    let back = 0;
    let queue = Promise.resolve();
    const send = async (bytes: Uint8Array, answer: { provenance: Answer["provenance"]; resolver: string }) => {
      await trace.append(stream, { kind: "result", surface: "mcp", connector, op: mcpShape(bytes)?.op ?? "", body: bytes, provenance: answer.provenance, resolver: answer.resolver });
      out.push(back++, bytes, true);
    };
    const handle = async (bytes: Uint8Array, history: readonly string[]): Promise<void> => {
      const shape = mcpShape(bytes);
      await trace.append(stream, { kind: "call", surface: "mcp", connector, op: shape?.op ?? "", body: bytes });
      if (!shape) return diverge({ trigger: "lifecycle", detail: `a message on ${connector} is not JSON-RPC` });
      if (!shape.message.method) return;
      if (!("id" in shape.message)) {
        if (index.notifications.get(connector)?.has(shape.message.method)) return;
        return diverge({ trigger: "lifecycle", detail: `the recording of ${connector} never has the harness send ${shape.message.method}` });
      }
      const call = { ...toCall({ surface: "mcp", connector, op: shape.op!, args: shape.args, raw: { body: bytes } }, policy(connector)), history };
      const answer = await respond(call);
      if (!answer) return;
      for (const during of answer.exchange?.during ?? []) {
        const message = mcpShape(during.message)?.message;
        const reply = during.reply && message && "id" in message ? new Promise<Uint8Array>(resolve => replies.set(JSON.stringify(message.id), resolve)) : undefined;
        await send(during.message, answer);
        if (reply && !sameReply(during.reply!, await reply))
          return diverge({ trigger: "lifecycle", detail: `the harness answered a server request during ${call.op} differently from the recording`, call: { connector, surface: "mcp", op: call.op, key: call.key } });
      }
      await send(withId(answer.raw.body, shape.message.id), answer);
      for (const message of answer.exchange?.after ?? []) await send(message, answer);
    };
    return {
      async write(f) {
        if (f.stream < 0) return;
        const chunk = [...parts.get(f.stream) ?? [], f.bytes];
        if (!f.last) { parts.set(f.stream, chunk); return; }
        parts.delete(f.stream);
        const bytes = concat(chunk);
        if (!bytes.length) { queue = queue.then(() => out.end()); return; }
        const shape = mcpShape(bytes);
        const waiting = shape && !shape.message.method ? replies.get(JSON.stringify(shape.message.id)) : undefined;
        if (waiting) {
          replies.delete(JSON.stringify(shape!.message.id));
          await trace.append(stream, { kind: "call", surface: "mcp", connector, op: "", body: bytes });
          waiting(bytes);
          return;
        }
        const history = ctx.histories[connector] ?? [];
        queue = queue.then(() => handle(bytes, history)).catch(interrupt);
      },
      frames: () => out.frames(),
      abort: () => out.end(),
    };
  };

  const serveHttp = async (out: Outbox, stream: string, connector: string, raw: WireMessage, answer: { provenance: Answer["provenance"]; resolver: string; note?: string }, op: string) => {
    const wire = raw.contentEncoding ? encodeBody(raw.body, raw.contentEncoding) : raw.body;
    const head = { ...raw.head!, headers: raw.head!.headers.map((value, i) => i % 2 === 1 && raw.head!.headers[i - 1]!.toLowerCase() === "content-length" ? String(wire.length) : value) };
    await trace.append(stream, { kind: "meta", surface: "http", connector, head });
    await trace.append(stream, {
      kind: "result", surface: "http", connector, op, body: raw.body, provenance: answer.provenance, resolver: answer.resolver, contentType: header(head.headers, "content-type") ?? "",
      contentEncoding: raw.contentEncoding ? "identity" : header(head.headers, "content-encoding") ?? "identity", ...(raw.contentEncoding ? { decodedFrom: raw.contentEncoding } : {}),
    });
    out.push(HTTP_STREAM.responseHead, encodeHttpHead(head), true);
    out.push(HTTP_STREAM.responseBody, wire, true);
  };

  const httpLink = (connector: string, meta: { request: { method: string; url: string; headers: string[]; httpVersion: string } }): Link => {
    const out = opened();
    const stream = streamName("http", connector || "unmapped", String(linkCount++));
    const parts: Uint8Array[] = [];
    const handle = async (body: Uint8Array): Promise<void> => {
      const request = meta.request;
      await trace.append(stream, { kind: "meta", surface: "http", connector, head: { ...request } });
      const path = new URL(request.url, "http://x").pathname;
      await trace.append(stream, { kind: "call", surface: "http", connector, op: `${request.method} ${path}`, body, contentType: header(request.headers, "content-type") ?? "", contentEncoding: header(request.headers, "content-encoding") ?? "identity" });
      if (stop) return;
      if (!connector) return diverge({ trigger: "unmapped-connection", detail: `no connector is bound to host ${httpHost(request)}` });
      const shape = httpShape(request, body);
      const call = toCall({ surface: "http", connector, op: shape.op, args: shape.args, raw: { body, head: request } }, policy(connector));
      const answer = await respond(call);
      if (!answer) return;
      await serveHttp(out, stream, connector, answer.raw, answer, call.op);
    };
    return {
      async write(f) {
        if (f.stream !== HTTP_STREAM.requestBody) return;
        parts.push(f.bytes);
        if (f.last) handle(concat(parts)).catch(error => { out.fail(error); return interrupt(error); });
      },
      frames: () => out.frames(),
      abort: () => out.end(),
    };
  };

  const backend: Backend = {
    open({ surface, connector, meta }) {
      const m = meta as { transport?: string; request?: { method: string; url: string; headers: string[]; httpVersion: string } };
      if (surface === "mcp" && m.transport === "stdio") return mcpLink(connector);
      if (surface === "cli") {
        try { return cliResponder({ ...responder("cli", connector), invocation: decodeCliInvocation(Buffer.from(JSON.stringify(meta))) }); }
        catch { void diverge({ trigger: "lifecycle", detail: `invalid CLI invocation on ${connector}` }); }
      }
      if (surface === "mcp" && m.transport === "http" && m.request) {
        const ids = mcpHttpIds.get(connector) ?? new Map<string, string>();
        mcpHttpIds.set(connector, ids);
        return mcpHttpResponder({ ...responder("mcp-http", connector), request: m.request, ids, waitFor });
      }
      if (m.transport === "http" && m.request && surface === "http") return httpLink(connector, { request: m.request });
      const out = opened();
      void diverge({ trigger: "unmapped-connection", detail: `the engine has no responder for ${surface} connections on ${connector}` });
      return { write: async () => {}, frames: () => out.frames(), abort: () => out.end() };
    },
  };
  const http = httpTap({ backend, route: request => {
    const path = new URL(request.url, "http://x").pathname;
    const connector = options.routes.mcpHttp?.[path];
    return connector ? { surface: "mcp", connector } : { surface: "http", connector: options.routes.http?.[httpHost(request)] ?? "" };
  } });

  return {
    state: connector => emulators.state(connector),
    backend, http, clock, stopped,
    accept({ destination, stream }) {
      const cli = options.routes.cli?.[destination.host];
      if (cli) { void cliRelay(stream, backend, cli).catch(error => { stream.destroy(); return diverge({ trigger: "lifecycle", detail: error instanceof Error ? error.message : String(error) }); }); return; }
      const connector = options.routes.mcp?.[destination.host];
      if (!connector) { http.emit("connection", stream); return; }
      mcpStdioTap({ backend, connector, io: { stdin: stream, stdout: stream, stderr: new PassThrough() } }).then(() => stream.end(), () => stream.destroy());
    },
    async close() { try { await emulators.close(); } finally { await trace.close(); } },
  };
}
