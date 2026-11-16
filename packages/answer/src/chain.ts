import { completeCall, type WriteHistories } from "@phoenix/wire";
import type { Divergence } from "./divergence.ts";
import { resolvers } from "./resolvers/index.ts";
import { simulatorConfig, type SimulatorOptions } from "./simulator.ts";
import type { Answer, Call, ConnectorPolicy, ExchangeIndex, ReplayCtx } from "./types.ts";
import type { Emulators } from "./emulators.ts";

export function replayCtx(index: ExchangeIndex, policy: (connector: string) => ConnectorPolicy, emulators?: Emulators, simulator?: SimulatorOptions): ReplayCtx {
  return { index, histories: {}, served: new Set(), policy, emulators, ...(simulator ? { simulator: simulatorConfig(simulator) } : {}) };
}

const served = (call: Call, ctx: ReplayCtx): void => { ctx.histories = completeCall(ctx.histories, call) as WriteHistories; };
const described = (call: Call) => ({ connector: call.connector, surface: call.surface, op: call.op, key: call.key });

export function answeredOutside(call: Call, answer: Answer, ctx: ReplayCtx): void {
  for (const observer of resolvers) observer.observe?.(call, answer, ctx);
  served(call, ctx);
}

export async function answerCall(call: Call, ctx: ReplayCtx, without: readonly string[] = []): Promise<{ answer: Answer } | { divergence: Divergence }> {
  const skip = new Set([...ctx.policy(call.connector).skip_resolvers ?? [], ...without]);
  const misses: { resolver: string; why: string }[] = [];
  const afterUntakenWrite = (ctx.emulators?.untaken(call.connector).length ?? 0) > 0;
  for (const resolver of resolvers) {
    if (skip.has(resolver.name)) { misses.push({ resolver: resolver.name, why: "removed for this connector by the manifest" }); continue; }
    const resolved = await resolver.resolve(call, ctx);
    if ("miss" in resolved) { misses.push({ resolver: resolver.name, why: resolved.why }); continue; }
    const result: Answer = afterUntakenWrite ? { ...resolved, afterUntakenWrite } : resolved;
    if (!skip.has("emulator")) await ctx.emulators?.observe(call, result);
    for (const observer of resolvers) observer.observe?.(call, result, ctx);
    served(call, ctx);
    return { answer: result };
  }
  const lifecycle = call.surface === "mcp" && !call.op.startsWith("tools/call:");
  return { divergence: { trigger: lifecycle ? "lifecycle" : "no-answer", detail: `no resolver answered ${call.op} on ${call.connector}`, call: described(call), misses } };
}
