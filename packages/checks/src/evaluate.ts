import { validate, type SuccessCheck, type ReplayResult } from "@phoenix/formats";
import { canonicalJson, object } from "@phoenix/wire";
import { collectEvidence, type CheckEvidence, type EvidenceInput } from "./evidence.ts";

export type Expectation = NonNullable<SuccessCheck["expect"]>[number];
export type ExpectationResult = ReplayResult["samples"][number]["expectations"][number] & { irreversible: boolean; evidenceThrough: number };
export type CustomCheck = (path: string, evidence: CheckEvidence) => Promise<boolean>;

export function matchesArgs(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const fields = object(expected);
    if (Object.keys(fields).length === 1 && "not" in fields) return !matchesArgs(actual, fields.not);
    return actual !== null && typeof actual === "object" && !Array.isArray(actual) && Object.entries(fields).every(([key, value]) => Object.hasOwn(actual, key) && matchesArgs(object(actual)[key], value));
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matchesArgs(actual[i], item));
  return actual === expected;
}

export async function evaluateCheck(check: SuccessCheck, input: EvidenceInput, options: {
  expectedStates?: Readonly<Record<string, unknown>>;
  custom?: CustomCheck;
} = {}): Promise<{ evidence: CheckEvidence; expectations: ExpectationResult[]; intentRequired: boolean }> {
  const validated = validate("check", check);
  if (!validated.ok) throw new Error(validated.errors.join("; "));
  let evidence: CheckEvidence;
  try { evidence = collectEvidence(input); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { evidence: { error: message, trace: [], actions: [], endStates: {}, notes: [message] }, expectations: (check.expect ?? []).map((_, expectation) => ({ expectation, outcome: "error", tainted: true, irreversible: false, evidenceThrough: 0, error: message })), intentRequired: check.intent !== undefined };
  }
  const end = evidence.trace.length;
  const expectations: ExpectationResult[] = [];
  for (const [expectation, exp] of (check.expect ?? []).entries()) {
    let passed = false, irreversible = false, through = end;
    try {
      if ("called" in exp || "not_called" in exp || "max_calls" in exp) {
        const rule = "called" in exp ? exp.called : "not_called" in exp ? exp.not_called : exp.max_calls;
        const actions = evidence.actions.filter(a => (rule.tool === "*" || a.tool === rule.tool) && (!("args" in rule) || matchesArgs(a.args, rule.args))).sort((a, b) => a.at - b.at);
        if ("called" in exp) {
          passed = exp.called.times === undefined ? actions.length > 0 : actions.length === exp.called.times;
          if (passed && exp.called.times === undefined) through = actions[0]!.at;
        } else if ("not_called" in exp) {
          passed = actions.length === 0;
          if (!passed) { irreversible = true; through = actions[0]!.at; }
        } else {
          passed = actions.length <= exp.max_calls.count;
          if (!passed) { irreversible = true; through = Math.max(...actions.slice(0, exp.max_calls.count + 1).map(a => a.at)); }
        }
      } else if ("order" in exp) {
        let next = 0;
        for (const action of evidence.actions) {
          if (!exp.order.includes(action.tool)) continue;
          if (action.tool === exp.order[next]) next++;
          else if (next === 0 || action.tool !== exp.order[next - 1]) {
            irreversible = true;
            through = Math.max(action.at, ...evidence.actions.filter(a => a.order <= action.order).map(a => a.at));
            break;
          }
        }
        passed = !irreversible && next === exp.order.length;
      } else if ("end_state" in exp) {
        if (!Object.hasOwn(options.expectedStates ?? {}, exp.end_state.equals)) throw new Error(`Missing expected state: ${exp.end_state.equals}`);
        const state = evidence.endStates[exp.end_state.connector];
        if (!state) throw new Error(`Missing end state: ${exp.end_state.connector}`);
        passed = canonicalJson(state.value) === canonicalJson(options.expectedStates![exp.end_state.equals]);
        through = state.at;
      } else if ("final_text" in exp) {
        if (!evidence.finalText) throw new Error("Missing final text");
        const rule = exp.final_text;
        passed = "contains" in rule ? evidence.finalText.value.includes(rule.contains) : new RegExp(rule.matches, "u").test(evidence.finalText.value);
        through = evidence.finalText.at;
      } else if ("custom" in exp) {
        if (!options.custom) throw new Error("Custom check host not configured");
        passed = await options.custom(exp.custom, evidence);
        if (typeof passed !== "boolean") throw new Error("Custom check must return a boolean");
      }
      expectations.push({ expectation, outcome: passed ? "pass" : "fail", tainted: evidence.firstSynthesized !== undefined && through >= evidence.firstSynthesized, irreversible, evidenceThrough: through });
    } catch (error) {
      expectations.push({ expectation, outcome: "error", tainted: evidence.firstSynthesized !== undefined && through >= evidence.firstSynthesized, irreversible: false, evidenceThrough: through, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { evidence, expectations, intentRequired: check.intent !== undefined };
}
