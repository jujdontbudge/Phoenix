import { validate, type Fill } from "@phoenix/formats";
import { canonicalJson, object } from "./json.ts";

export interface FillLocation { evidence: string; connector?: string; at?: string }
export type FillDerivation = { ok: true; fill: Fill } | { ok: false; why: string };

function fill(item: string, rule: string, value: Fill["value"], location: FillLocation): FillDerivation {
  if (!location.evidence) return { ok: false, why: "Missing evidence location" };
  try { canonicalJson(value); } catch { return { ok: false, why: "Fill contains non-JSON values" }; }
  const result = validate("fill", {
    phoenix_fill: 1, item, tag: "derived", basis: { rule, evidence: [location.evidence] },
    producer: `wire:${rule}`, value,
    ...(location.connector === undefined ? {} : { connector: location.connector }),
    ...(location.at === undefined ? {} : { at: location.at }),
  });
  return result.ok ? { ok: true, fill: result.value } : { ok: false, why: "Invalid fill" };
}

export function deriveMcpResult(text: string, location: FillLocation, isError?: boolean): FillDerivation {
  if (typeof text !== "string" || isError !== undefined && typeof isError !== "boolean") return { ok: false, why: "Missing verbatim result text" };
  return fill("mcp.tools/call.result", "mcp-result-from-text", {
    content: [{ type: "text", text }], ...(isError === undefined ? {} : { isError }),
  }, location);
}

export function deriveSerializedMcpResult(text: string, location: FillLocation): FillDerivation {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, why: "Result text is not JSON" }; }
  const content = object(value).content;
  if (!Array.isArray(content) || !content.every(block => typeof object(block).type === "string") || JSON.stringify(value) !== text)
    return { ok: false, why: "Result text is not a serialized MCP result" };
  return fill("mcp.tools/call.result", "mcp-result-from-serialized-result", value as Fill["value"], location);
}

