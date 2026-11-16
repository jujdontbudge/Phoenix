import { validate, type TraceEvent } from "@phoenix/formats";
import { decodeCliInvocation, object } from "@phoenix/wire";

export interface Action {
  tool: string;
  args: unknown;
  event: string;
  at: number;
  order: number;
}

export interface EvidenceInput {
  trace: readonly TraceEvent[];
  blobs?: Readonly<Record<string, string>>;
}

export interface CheckEvidence {
  error?: string;
  trace: readonly TraceEvent[];
  actions: Action[];
  endStates: Record<string, { value: unknown; at: number }>;
  finalText?: { value: string; at: number };
  firstSynthesized?: number;
  notes: string[];
}

export const eventId = (event: TraceEvent): string => event.id ?? `${event.stream}:${event.seq}`;

export function bodyText(event: TraceEvent, blobs: EvidenceInput["blobs"]): string {
  if (!event.body) throw new Error(`Missing body: ${eventId(event)}`);
  if ("inline" in event.body) return event.body.inline;
  const text = blobs?.[event.body.blob];
  if (text === undefined) throw new Error(`Missing blob: ${event.body.blob}`);
  return text;
}

export function collectEvidence(input: EvidenceInput): CheckEvidence {
  for (const event of input.trace) {
    const result = validate("trace", event);
    if (!result.ok) throw new Error(result.errors.join("; "));
  }
  const trace = [...input.trace];
  const evidence: CheckEvidence = { trace, actions: [], endStates: {}, notes: [] };
  for (const [at, event] of trace.entries()) {
    if (event.kind === "result" && event.provenance === "synthesized" && evidence.firstSynthesized === undefined) evidence.firstSynthesized = at;
    if (event.layer === "under") continue;
    if (event.kind === "meta" && event.op === "end_state" && event.connector) {
      evidence.endStates[event.connector] = { value: JSON.parse(bodyText(event, input.blobs)), at };
    }
    if (event.kind === "meta" && event.op === "final_text") evidence.finalText = { value: bodyText(event, input.blobs), at };
    if (event.kind !== "call" || event.layer !== "agent" || !event.connector || !event.op) continue;
    if (event.partial) throw new Error(`Partial action evidence: ${eventId(event)}`);
    const text = bodyText(event, input.blobs);
    let args: unknown;
    let name = event.op;
    if (event.surface === "mcp") {
      if (!event.op.startsWith("tools/call:")) continue;
      const rpc = object(JSON.parse(text));
      name = event.op.slice("tools/call:".length);
      args = object(rpc.params).arguments ?? {};
    } else if (event.surface === "cli") args = decodeCliInvocation(new TextEncoder().encode(text));
    else { try { args = JSON.parse(text); } catch { args = text; } }
    evidence.actions.push({ tool: `${event.connector}.${name}`, args, event: eventId(event), at, order: at });
  }
  return evidence;
}
