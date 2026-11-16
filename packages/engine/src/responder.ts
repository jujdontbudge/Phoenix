import type { Answer, Call, ConnectorPolicy, Divergence } from "@phoenix/answer";
import type { Frame } from "@phoenix/taps";
import type { SampleTrace } from "./trace.ts";

export class Outbox {
  #queue: Frame[] = [];
  #wake: (() => void) | undefined;
  #done = false;
  #error: Error | undefined;
  push(stream: number, bytes: Uint8Array, last: boolean): void {
    if (this.#done || this.#error) return;
    this.#queue.push({ dir: "back", stream, bytes, last, at: process.hrtime.bigint() });
    this.#wake?.();
  }
  end(): void { this.#done = true; this.#wake?.(); }
  fail(error: Error): void { this.#error ??= error; this.#wake?.(); }
  async *frames(): AsyncGenerator<Frame> {
    for (;;) {
      if (this.#error) throw this.#error;
      const next = this.#queue.shift();
      if (next) { yield next; continue; }
      if (this.#done) return;
      await new Promise<void>(resolve => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

export interface Responder {
  connector: string;
  stream: string;
  out: Outbox;
  trace: SampleTrace;
  policy: ConnectorPolicy;
  history(): readonly string[];
  respond(call: Call): Promise<Answer | undefined>;
  diverge(divergence: Divergence): Promise<void>;
  interrupt(error: unknown): Promise<void>;
}
