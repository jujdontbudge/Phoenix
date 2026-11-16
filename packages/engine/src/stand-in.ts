import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { text } from "node:stream/consumers";
import { answerCall, answeredOutside, cliShape, Emulators, replayCtx, toCall, type CliReplayFrame, type ConnectorPolicy, type EmulatorConfig, type Divergence, type Exchange, type ExchangeIndex, type SimulatorOptions } from "@phoenix/answer";
import type { CaptureMetadata } from "@phoenix/store";
import { CLI_STREAM } from "@phoenix/taps";
import { VirtualClock } from "./clock.ts";
import { SampleTrace, streamName } from "./trace.ts";

export interface RecordedToolAnswer {
  id: string;
  connector: string;
  op: string;
  args: unknown;
  result: unknown;
  observedAt: string;
  beforeCut: boolean;
  world?: "exact" | "any-args";
}

export interface ToolStandInOptions {
  host: string;
  answers: readonly RecordedToolAnswer[];
  policy(connector: string): ConnectorPolicy;
  inBox?(connector: string, op: string, args: unknown): boolean;
  pluginCommand?(connector: string, op: string, args: unknown): { calls: { connector: string; argv: string[]; env: Record<string, string>; cwd: string; stdin?: string }[]; around: string } | undefined;
  simulator?: Omit<SimulatorOptions, "clock">;
  emulators?: readonly EmulatorConfig[];
  cutTime?: string;
  sample: { root: string; metadata: CaptureMetadata };
  hmacKey: Uint8Array;
}

export interface ToolStandIn {
  accept(connection: { destination: { host: string; port: number }; stream: Duplex }): void;
  served(): number;
  note(op: string, value: unknown): Promise<void>;
  stopped: Promise<Divergence>;
  close(): Promise<void>;
}

const rpc = (id: unknown, body: object) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...body }));

export async function startToolStandIn(options: ToolStandInOptions): Promise<ToolStandIn> {
  const cutTime = options.cutTime ?? new Date().toISOString();
  const policy = (connector: string): ConnectorPolicy => ({ allow_synthesized: true, ...options.policy(connector) });
  const started = Date.now();
  const emulators = await Emulators.start((options.emulators ?? []).filter(c => !policy(c.plugin.descriptor.connector).skip_resolvers?.includes("emulator")), () => new Date(Date.parse(cutTime) + Date.now() - started));
  const clock = new VirtualClock(new Date());
  const trace = await SampleTrace.create(options.sample.root, options.sample.metadata, clock, options.hmacKey);
  const exchanges: Exchange[] = options.answers.map((answer, position) => {
    const op = `tools/call:${answer.op}`;
    const request = { body: rpc(position, { method: "tools/call", params: { name: answer.op, arguments: answer.args } }) };
    const call = toCall({ surface: "mcp", connector: answer.connector, op, args: answer.args, raw: request }, policy(answer.connector));
    const world = answer.world ? { key: `world:${call.key}`, anyArgs: answer.world === "any-args", provenance: "seeded" as const } : { provenance: "recorded" as const };
    return { ...call, id: answer.id, history: [], frozen: answer.beforeCut, position, completed: position, observedAt: answer.observedAt, request, response: { body: rpc(position, { result: answer.result }) }, during: [], after: [], ...world };
  });
  for (const exchange of exchanges) exchange.history = exchanges.filter(w => w.connector === exchange.connector && !w.readOnly && w.completed < exchange.position).map(w => w.key);
  const index: ExchangeIndex = { exchanges, prefetch: [], frozen: exchanges.filter(e => e.frozen), continuation: exchanges.filter(e => !e.frozen), notifications: new Map(), startTime: cutTime, cutTime: cutTime };
  const ctx = replayCtx(index, policy, emulators, options.simulator ? { ...options.simulator, clock: () => cutTime } : undefined);
  for (const exchange of index.frozen) if (!exchange.readOnly) ctx.histories = { ...ctx.histories, [exchange.connector]: [...(ctx.histories[exchange.connector] ?? []), exchange.key] };
  let served = 0;
  let stop!: (divergence: Divergence) => void;
  const stopped = new Promise<Divergence>(resolve => { stop = resolve; });
  const server = createServer((request, response) => {
    void (async () => {
      const connector = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.slice(1));
      const body = Buffer.from(await text(request));
      const message = JSON.parse(body.toString()) as { id: unknown; method: string; params: { name: string; arguments?: unknown; result?: unknown } };
      const stream = streamName("stand-in", connector);
      response.setHeader("content-type", "application/json");
      if (message.method === "phoenix/ran") {
        await trace.append(stream, { kind: "meta", connector, op: "files-copy.output", body: Buffer.from(JSON.stringify({ tool: message.params.name, result: message.params.result ?? null })) });
        response.end(rpc(message.id, { result: {} }));
        return;
      }
      const call = toCall({ surface: "mcp", connector, op: `tools/call:${message.params.name}`, args: message.params.arguments ?? {}, raw: { body } }, policy(connector));
      await trace.append(stream, { kind: "call", surface: "mcp", layer: "agent", connector, op: call.op, body });
      const inBox = options.inBox?.(connector, message.params.name, message.params.arguments ?? {}) ?? false;
      const command = options.pluginCommand?.(connector, message.params.name, message.params.arguments ?? {});
      const routed = command?.calls.every(c => emulators.has(c.connector)) ? command : undefined;
      let answered = await answerCall(call, ctx, inBox || routed ? ["simulator"] : []);
      if ("divergence" in answered && routed) {
        const outputs: { stdout: string; stderr: string; exit_code: number }[] = [];
        let miss: string | undefined;
        for (const { connector: plugin, argv, env, cwd, stdin } of routed.calls) {
          const invocation = { argv, cwd, env, terminals: { stdin: null, stdout: null, stderr: null } };
          const cliBody = Buffer.from(JSON.stringify(invocation));
          const cliStream = streamName("stand-in", plugin);
          const cli = { ...toCall({ surface: "cli", layer: "under", connector: plugin, ...cliShape(invocation), raw: { body: cliBody } }, policy(plugin)), stdin: async () => Buffer.from(stdin ?? "") };
          await trace.append(cliStream, { kind: "call", surface: "cli", layer: "under", connector: plugin, op: cli.op, body: cliBody });
          const copied = await emulators.resolve(cli);
          if ("miss" in copied) {
            miss = copied.why;
            await trace.append(cliStream, { kind: "meta", connector: plugin, op: "plugin-copy.miss", body: Buffer.from(copied.why) });
            break;
          }
          const frames = JSON.parse(Buffer.from(copied.raw.body).toString()) as CliReplayFrame[];
          const bytes = (stream: number) => Buffer.concat(frames.filter(f => f.dir === "back" && f.stream === stream).map(f => Buffer.from(f.bytes, "base64"))).toString();
          const exit = JSON.parse(bytes(CLI_STREAM.control) || "{}") as { code?: number | null };
          const output = { stdout: bytes(CLI_STREAM.stdout), stderr: bytes(CLI_STREAM.stderr), exit_code: exit.code ?? 1 };
          outputs.push(output);
          await trace.append(cliStream, { kind: "result", surface: "cli", layer: "under", connector: plugin, op: cli.op, body: Buffer.from(JSON.stringify(output)), provenance: copied.provenance, resolver: copied.resolver });
        }
        if (miss === undefined) {
          const reply = rpc(message.id, { command_output: { command: routed.around, outputs } });
          answeredOutside(call, { raw: { body: reply }, provenance: "derived", resolver: "emulator" }, ctx);
          served++;
          await trace.append(stream, { kind: "result", surface: "mcp", layer: "agent", connector, op: call.op, body: reply, provenance: "derived", resolver: "emulator" });
          response.end(reply);
          return;
        }
        if (!inBox) answered = await answerCall(call, ctx);
      }
      if ("divergence" in answered && inBox) {
        const reply = rpc(message.id, { run_in_box: true });
        answeredOutside(call, { raw: { body: reply }, provenance: "real", resolver: "files-copy" }, ctx);
        served++;
        await trace.append(stream, { kind: "result", surface: "mcp", layer: "agent", connector, op: call.op, body: reply, provenance: "real", resolver: "files-copy" });
        response.end(reply);
        return;
      }
      if ("divergence" in answered) {
        const { divergence } = answered;
        await trace.append(stream, { kind: "divergence", connector, op: call.op, body: Buffer.from(JSON.stringify(divergence)) });
        response.end(rpc(message.id, { error: { code: -32000, message: divergence.detail } }));
        stop(divergence);
        return;
      }
      const recorded = JSON.parse(Buffer.from(answered.answer.raw.body).toString()) as { result: unknown };
      const reply = rpc(message.id, { result: recorded.result });
      served++;
      await trace.append(stream, { kind: "result", surface: "mcp", layer: "agent", connector, op: call.op, body: reply, provenance: answered.answer.provenance, resolver: answered.answer.resolver, afterUntakenWrite: answered.answer.afterUntakenWrite });
      response.end(reply);
    })().catch(error => {
      stop({ trigger: "lifecycle", detail: error instanceof Error ? error.message : String(error) });
      response.destroy();
    });
  });
  return {
    accept({ destination, stream }) {
      if (destination.host === options.host) { server.emit("connection", stream); return; }
      void trace.append("sandbox", { kind: "meta", op: "refused-connection", body: Buffer.from(JSON.stringify(destination)) });
      stream.destroy();
    },
    served: () => served,
    async note(op, value) { await trace.append("resume", { kind: "meta", op, body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) }); },
    stopped,
    async close() { server.close(); try { await emulators.close(); } finally { await trace.close(); } },
  };
}
