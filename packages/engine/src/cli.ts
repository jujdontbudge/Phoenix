import type { Duplex } from "node:stream";
import { cliShape, toCall, type CliReplayFrame } from "@phoenix/answer";
import { CLI_STREAM, decodeCliControl, decodeCliInvocation, type Backend, type CliInvocation, type Frame, type Link } from "@phoenix/taps";
import type { Responder } from "./responder.ts";

export function cliResponder(options: Responder & { invocation: CliInvocation }): Link {
  const { connector, stream, out, trace } = options;
  const inputs: Frame[] = [];
  const history = options.history();
  let wake: (() => void) | undefined;
  let aborted = false;
  const mismatch = () => options.diverge({ trigger: "lifecycle", detail: `CLI stdin, signal or terminal resize differs from the recording on ${connector}` });
  const run = async (): Promise<void> => {
    const invocation = Buffer.from(JSON.stringify(options.invocation));
    await trace.append(stream, { kind: "call", surface: "cli", connector, op: options.invocation.argv[0] ?? "", body: invocation });
    let delivered = false;
    const stdin = async (): Promise<Uint8Array> => {
      delivered = true;
      while (!aborted && !inputs.some(f => f.stream === CLI_STREAM.stdin && f.last)) await new Promise<void>(resolve => { wake = resolve; });
      return Buffer.concat(inputs.filter(f => f.stream === CLI_STREAM.stdin).map(f => f.bytes));
    };
    const call = { ...toCall({ surface: "cli", connector, ...cliShape(options.invocation), raw: { body: invocation } }, options.policy), history, ...(options.invocation.terminals.stdin === null ? { stdin } : {}) };
    const answer = await options.respond(call);
    if (!answer) return;
    const frames = JSON.parse(Buffer.from(answer.raw.body).toString()) as CliReplayFrame[];
    if (delivered && !frames.some(f => f.dir === "out" && f.stream === CLI_STREAM.stdin)) inputs.splice(0, inputs.length, ...inputs.filter(f => f.stream !== CLI_STREAM.stdin));
    let actual: Frame | undefined;
    let offset = 0;
    let stdinEnded = false;
    const next = async (): Promise<boolean> => {
      if (actual) return true;
      while (!inputs.length && !aborted) await new Promise<void>(resolve => { wake = resolve; });
      if (aborted) return false;
      actual = inputs.shift()!;
      offset = 0;
      return true;
    };
    for (const expected of frames) {
      if (aborted) return;
      const bytes = Buffer.from(expected.bytes, "base64");
      if (expected.dir === "back") {
        const exit = expected.stream === CLI_STREAM.control && decodeCliControl(bytes).type === "exit";
        if (exit && (actual || inputs.some(f => f.bytes.length || f.stream !== CLI_STREAM.stdin || !f.last))) return mismatch();
        await trace.append(stream, { kind: "result", surface: "cli", connector, op: `${expected.last ? "frame" : "fragment"}:back:${expected.stream}`, body: bytes, provenance: answer.provenance, resolver: answer.resolver });
        out.push(expected.stream, bytes, expected.last);
        continue;
      }
      if (expected.stream === CLI_STREAM.control) {
        if (!await next()) return;
        if (actual!.stream !== CLI_STREAM.control || offset || !actual!.last || !Buffer.from(actual!.bytes).equals(bytes)) return mismatch();
        actual = undefined;
        continue;
      }
      let consumed = 0;
      while (consumed < bytes.length) {
        if (!actual && stdinEnded) return mismatch();
        if (!await next()) return;
        if (actual!.stream !== CLI_STREAM.stdin) return mismatch();
        const count = Math.min(bytes.length - consumed, actual!.bytes.length - offset);
        if (!Buffer.from(actual!.bytes.subarray(offset, offset + count)).equals(bytes.subarray(consumed, consumed + count))) return mismatch();
        offset += count;
        consumed += count;
        if (offset === actual!.bytes.length) {
          stdinEnded = actual!.last;
          actual = undefined;
        }
      }
      if (expected.last) while (!stdinEnded) {
        if (!await next()) return;
        if (actual!.stream !== CLI_STREAM.stdin || actual!.bytes.length !== offset) return mismatch();
        stdinEnded = actual!.last;
        actual = undefined;
      }
    }
    if (actual || inputs.some(f => f.bytes.length || f.stream !== CLI_STREAM.stdin || !f.last)) return mismatch();
    out.end();
  };
  void run().catch(error => { out.fail(error); return options.interrupt(error); });
  return {
    async write(f) {
      if (aborted) return;
      if (f.dir !== "out" || ![CLI_STREAM.stdin, CLI_STREAM.control].includes(f.stream as 0 | 3)) return mismatch();
      if (f.stream === CLI_STREAM.control && decodeCliControl(f.bytes).type === "exit") return mismatch();
      await trace.append(stream, { kind: "call", surface: "cli", layer: "under", connector, op: `${f.last ? "frame" : "fragment"}:out:${f.stream}`, body: f.bytes });
      inputs.push(f);
      wake?.();
    },
    frames: () => out.frames(),
    abort() { aborted = true; wake?.(); out.end(); },
  };
}

export async function cliRelay(stream: Duplex, backend: Backend, connector: string): Promise<void> {
  let link: Link | undefined;
  let pending = Buffer.alloc(0);
  let output: Promise<void> | undefined;
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        if (!link) {
          const invocation = decodeCliInvocation(line);
          link = backend.open({ surface: "cli", connector, meta: invocation });
          const opened = link;
          output = (async () => {
            for await (const f of opened.frames()) await new Promise<void>((resolve, reject) => stream.write(JSON.stringify({ stream: f.stream, bytes: Buffer.from(f.bytes).toString("base64"), last: f.last }) + "\n", error => error ? reject(error) : resolve()));
            stream.end();
          })();
          void output.catch(() => stream.destroy());
        } else {
          const f = JSON.parse(line.toString()) as { stream: number; bytes: string; last: boolean };
          if (!Number.isInteger(f.stream) || typeof f.bytes !== "string" || typeof f.last !== "boolean" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.bytes)) throw new Error("Invalid CLI relay frame");
          await link.write({ dir: "out", stream: f.stream, bytes: Buffer.from(f.bytes, "base64"), last: f.last, at: process.hrtime.bigint() });
        }
      }
    }
    if (pending.length) throw new Error("Partial CLI relay record");
    await output;
  } finally { link?.abort("CLI relay closed"); }
}
