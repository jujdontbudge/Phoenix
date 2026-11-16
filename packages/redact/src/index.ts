import { createHmac } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { lintSource } from "@secretlint/core";
import { secretLintProfiler } from "@secretlint/profiler";
import { creator } from "@secretlint/secretlint-rule-preset-recommend";
import { LiteOpenRedaction } from "@openredaction/core/lite";
import type { TraceEvent } from "@phoenix/formats";

export interface Change { at: string; rule: string }
export interface SecretPolicy {
  hmacKey: Uint8Array;
  patterns?: readonly { name: string; pattern: RegExp }[];
}
export interface WireMessage {
  url?: string;
  headers?: Readonly<Record<string, string | readonly string[]>>;
  body?: Uint8Array;
  contentEncoding?: string;
  contentType?: string;
  secrets?: TraceEvent["secrets"];
}
export interface RedactedMessage {
  msg: WireMessage;
  changes: Change[];
  unscanned: string[];
  originalEncoding?: string;
}
export interface Detection { start: number; end: number; type: string }
export interface PersonalDataDetector { detect(text: string): Promise<readonly Detection[]> }
export interface PackPolicy { hmacKey: Uint8Array; detector?: PersonalDataDetector }

secretLintProfiler.setEnabled(false);

type Span = { start: number; end: number; replacement: string; rule: string };
const secretName = (name: string) => /^(authorization|proxyauthorization|cookie|setcookie|.*apikey|.*authkey|.*token|.*password|.*passwd|.*secret|.*privatekey|credential|credentials)$/i.test(name.replace(/[^a-z0-9]/gi, ""));
const placeholder = (value: string, type: string, key: Uint8Array) => `[${type}:${createHmac("sha256", key).update(value).digest("hex")}]`;
const checkKey = (key: Uint8Array) => { if (key.length < 32) throw new Error("Redaction requires an HMAC key of at least 32 bytes"); };

function applySpans(text: string, spans: Span[]): { text: string; used: Span[] } {
  const used: Span[] = [];
  let end = 0;
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (span.start < end || span.start < 0 || span.end > text.length || span.end <= span.start) continue;
    used.push(span); end = span.end;
  }
  let result = "", offset = 0;
  for (const span of used) { result += text.slice(offset, span.start) + span.replacement; offset = span.end; }
  return { text: result + text.slice(offset), used };
}

function secretAssignments(text: string, policy: SecretPolicy): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(/(?:^|\n)[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*[:=][ \t]*([^\r\n]+)/g)) {
    if (!secretName(match[1]!)) continue;
    const value = match[2]!, start = match.index + match[0].lastIndexOf(value);
    spans.push({ start, end: start + value.length, replacement: placeholder(value, "secret", policy.hmacKey), rule: "secret-field" });
  }
  return spans;
}

async function scanSecrets(text: string, policy: SecretPolicy): Promise<{ text: string; used: Span[] }> {
  const spans: Span[] = [];
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/@]+)@/gi)) {
    const start = match.index + match[0].indexOf(match[1]!);
    spans.push({ start, end: start + match[1]!.length, replacement: encodeURIComponent(placeholder(match[1]!, "secret", policy.hmacKey)), rule: "url-credentials" });
  }
  for (const match of text.matchAll(/[?&]([^=&\s#]+)=([^&#\s]*)/g)) {
    let name: string, original: string;
    try { name = decodeURIComponent(match[1]!); original = decodeURIComponent(match[2]!); } catch { continue; }
    if (!secretName(name) || !original) continue;
    const start = match.index + match[0].length - match[2]!.length;
    spans.push({ start, end: start + match[2]!.length, replacement: encodeURIComponent(placeholder(original, "secret", policy.hmacKey)), rule: "secret-query" });
  }
  spans.push(...secretAssignments(text, policy));
  const result = await lintSource({
    source: { content: text, contentType: "text", filePath: "message.txt" },
    options: { noPhysicFilePath: true, maskSecrets: true, config: { rules: [{ id: "recommended", rule: creator }] } },
  });
  for (const match of result.messages) {
    const [start, end] = match.range;
    if (spans.some((s) => s.rule === "url-credentials" && start <= s.start && end >= s.end)) continue;
    spans.push({ start, end, replacement: placeholder(text.slice(start, end), "secret", policy.hmacKey), rule: match.ruleId });
  }
  for (const rule of policy.patterns ?? []) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    for (const match of text.matchAll(pattern)) spans.push({ start: match.index, end: match.index + match[0].length, replacement: placeholder(match[0], "secret", policy.hmacKey), rule: rule.name });
  }
  return applySpans(text, spans);
}

async function transformJson(text: string, scan: (value: string, at: string) => Promise<string>, secret?: SecretPolicy, changes?: Change[]): Promise<string> {
  JSON.parse(text);
  let offset = 0;
  const spans: Span[] = [];
  const space = () => { while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++; };
  const stringEnd = () => {
    offset++;
    while (offset < text.length) {
      const ch = text[offset++];
      if (ch === "\\") offset++;
      else if (ch === '"') break;
    }
  };
  const value = async (at: string, hide = false, propertyNames = false): Promise<void> => {
    space();
    const start = offset;
    if (text[offset] === "{") {
      offset++; space(); let keyIndex = 0;
      while (text[offset] !== "}") {
        const keyStart = offset; stringEnd();
        const key = JSON.parse(text.slice(keyStart, offset)) as string;
        const keyEnd = offset;
        const nextKey = secret ? key : await scan(key, `body${at}/$key:${keyIndex++}`);
        if (nextKey !== key) spans.push({ start: keyStart, end: keyEnd, replacement: JSON.stringify(nextKey), rule: at });
        space(); offset++; space();
        const schemaProperty = propertyNames && text[offset] === "{";
        await value(`${at}/${nextKey.replace(/~/g, "~0").replace(/\//g, "~1")}`, !hide && !!secret && secretName(key) && !schemaProperty, key === "properties" && /\/(input_?schema|parameters|schema)(\/|$)/i.test(at));
        space(); if (text[offset] !== ",") break; offset++; space();
      }
      offset++;
    } else if (text[offset] === "[") {
      offset++; space(); let index = 0;
      while (text[offset] !== "]") {
        await value(`${at}/${index++}`); space(); if (text[offset] !== ",") break; offset++; space();
      }
      offset++;
    } else if (text[offset] === '"') stringEnd();
    else { while (offset < text.length && !/[\s,}\]]/.test(text[offset]!)) offset++; }
    const raw = text.slice(start, offset);
    if (hide && secret) {
      const parsed: unknown = JSON.parse(raw);
      const original = typeof parsed === "string" ? parsed : raw;
      spans.push({ start, end: offset, replacement: JSON.stringify(placeholder(original, "secret", secret.hmacKey)), rule: at });
      changes?.push({ at: `body${at}`, rule: "secret-key" });
    } else if (text[start] === '"') {
      const original = JSON.parse(raw) as string, next = await scan(original, `body${at}`);
      if (next !== original) spans.push({ start, end: offset, replacement: JSON.stringify(next), rule: at });
    } else if (/^-?\d/.test(raw)) {
      const next = await scan(raw, `body${at}`);
      if (next !== raw) spans.push({ start, end: offset, replacement: JSON.stringify(next), rule: at });
    }
  };
  await value("");
  return applySpans(text, spans).text;
}

async function transformText(text: string, scan: (value: string, at: string) => Promise<string>, secret?: SecretPolicy, changes?: Change[]): Promise<string> {
  try { JSON.parse(text); return await transformJson(text, scan, secret, changes); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const segments = secret ? secretAssignments(text, secret) : [];
  for (const span of segments) changes?.push({ at: `body:${span.start}`, rule: span.rule });
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const enclosing = segments.find((s) => s.start <= start && start < s.end);
    if (enclosing) { start = enclosing.end - 1; continue; }
    let depth = 0, quoted = false, escaped = false, end = start;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) { end++; break; }
    }
    if (depth || quoted) continue;
    const fragment = text.slice(start, end);
    try { JSON.parse(fragment); } catch { continue; }
    segments.push({ start, end, replacement: await transformJson(fragment, scan, secret, changes), rule: "json-fragment" });
    start = end - 1;
  }
  let result = "", plainStart = 0;
  for (const segment of segments.sort((a, b) => a.start - b.start)) {
    result += await scan(text.slice(plainStart, segment.start), `body:${plainStart}`) + segment.replacement;
    plainStart = segment.end;
  }
  return result + await scan(text.slice(plainStart), `body:${plainStart}`);
}

async function transformForm(text: string, scan: (value: string, at: string) => Promise<string>, secret?: SecretPolicy, changes?: Change[]): Promise<string> {
  const spans: Span[] = [];
  for (const match of text.matchAll(/(^|&)([^=&]+)=([^&]*)/g)) {
    let key: string, value: string;
    try { key = decodeURIComponent(match[2]!.replace(/\+/g, " ")); value = decodeURIComponent(match[3]!.replace(/\+/g, " ")); }
    catch { throw new Error("Unreadable form encoding"); }
    const next = secret && secretName(key) ? placeholder(value, "secret", secret.hmacKey) : await scan(value, "body/form-value");
    if (next !== value) {
      const start = match.index + match[0].length - match[3]!.length;
      spans.push({ start, end: start + match[3]!.length, replacement: encodeURIComponent(next), rule: "secret-key" });
      if (secret && secretName(key)) changes?.push({ at: `body/${key}`, rule: "secret-key" });
    }
    if (!secret) {
      const nextKey = await scan(key, "body/form-key");
      if (nextKey !== key) {
        const start = match.index + match[1]!.length;
        spans.push({ start, end: start + match[2]!.length, replacement: encodeURIComponent(nextKey), rule: "personal-key" });
      }
    }
  }
  return applySpans(text, spans).text;
}

async function transformUrl(text: string, scan: (value: string, at: string) => Promise<string>): Promise<string> {
  const spans: Span[] = [];
  for (const match of text.matchAll(/[^/?#&=]+/g)) {
    const inQuery = text.lastIndexOf("?", match.index) > text.lastIndexOf("#", match.index);
    let original: string;
    try { original = decodeURIComponent(inQuery ? match[0].replace(/\+/g, " ") : match[0]); }
    catch { throw new Error("Unreadable URL encoding"); }
    const next = await scan(original, `url:${match.index}`);
    if (next !== original) spans.push({ start: match.index, end: match.index + match[0].length, replacement: encodeURIComponent(next), rule: "personal-url" });
  }
  return applySpans(text, spans).text;
}

function decodeBody(msg: WireMessage): Uint8Array {
  const bytes = msg.body!;
  const encodings = (msg.contentEncoding ?? "identity").split(",").map((e) => e.trim().toLowerCase()).reverse();
  let decoded = Buffer.from(bytes);
  for (const encoding of encodings) {
    if (encoding === "identity") continue;
    if (encoding === "gzip") decoded = gunzipSync(decoded);
    else if (encoding === "deflate") decoded = inflateSync(decoded);
    else if (encoding === "br") decoded = brotliDecompressSync(decoded);
    else if (encoding === "zstd") decoded = zstdDecompressSync(decoded);
    else throw new Error("Unsupported content encoding");
  }
  return decoded;
}

function bodyText(msg: WireMessage): string {
  if (msg.contentType && !/^(text\/|application\/(?:[\w.+-]*json|[\w.+-]*xml|javascript|x-www-form-urlencoded)|[^;]+\+(?:json|xml))/i.test(msg.contentType))
    throw new Error("Body is not readable text");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeBody(msg));
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error("Body is not readable text");
  return text;
}

export async function stripSecrets(msg: WireMessage, policy: SecretPolicy): Promise<RedactedMessage> {
  checkKey(policy.hmacKey);
  const changes: Change[] = [], unscanned: string[] = [];
  const next: WireMessage = { ...msg };
  const scan = async (text: string, at: string): Promise<string> => {
    if (/^\s*[[{]/.test(text)) {
      try { JSON.parse(text); return await transformJson(text, scan, policy, changes); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    const result = await scanSecrets(text, policy);
    changes.push(...result.used.map((s) => ({ at: `${at}:${s.start}`, rule: s.rule })));
    return result.text;
  };
  if (msg.url !== undefined) next.url = await scan(msg.url, "url");
  if (msg.headers) {
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries(msg.headers)) {
      const values = typeof value === "string" ? [value] : value;
      const stripped: string[] = [];
      for (const text of values) {
        if (secretName(name)) { stripped.push(placeholder(text, "secret", policy.hmacKey)); changes.push({ at: `headers/${name}`, rule: "auth-header" }); }
        else stripped.push(await scan(text, `headers/${name}`));
      }
      headers[name] = typeof value === "string" ? stripped[0]! : stripped;
    }
    next.headers = headers;
  }
  let originalEncoding: string | undefined;
  if (msg.body !== undefined) {
    const bodyChanges = changes.length;
    try {
      const text = bodyText(msg);
      const result = /^application\/x-www-form-urlencoded\b/i.test(msg.contentType ?? "")
        ? await transformForm(text, scan, policy, changes) : await transformText(text, scan, policy, changes);
      if (result !== text) {
        next.body = Buffer.from(result);
        if (msg.contentEncoding && msg.contentEncoding !== "identity") {
          originalEncoding = msg.contentEncoding;
          delete next.contentEncoding;
        }
      }
    } catch {
      changes.length = bodyChanges;
      unscanned.push("body"); next.secrets = "unscanned";
      return { msg: next, changes, unscanned };
    }
  }
  next.secrets = unscanned.length ? "unscanned" : changes;
  return { msg: next, changes, unscanned, ...(originalEncoding ? { originalEncoding } : {}) };
}

const PERSONAL_PATTERNS = ["EMAIL", "PHONE_US", "PHONE_UK", "PHONE_UK_MOBILE", "PHONE_INTERNATIONAL", "CREDIT_CARD", "IBAN", "SSN", "PASSPORT_US", "PASSPORT_UK", "NATIONAL_INSURANCE_UK", "NHS_NUMBER", "IPV4", "IPV6", "DATE_OF_BIRTH"];

export function openRedactionDetector(): PersonalDataDetector {
  const detector = new LiteOpenRedaction({ patterns: PERSONAL_PATTERNS, enableCache: false, debug: false, enableAuditLog: false, enableMetrics: false, enableContextAnalysis: false, enableFalsePositiveFilter: false, confidenceThreshold: 0 });
  return { async detect(text) {
    const result = await detector.detect(text);
    return result.detections.map((d) => ({ start: d.position[0], end: d.position[1], type: d.type }));
  } };
}

export async function scrubPersonalData(msg: WireMessage, policy: PackPolicy): Promise<RedactedMessage & { withheld?: { size: number; reason: string } }> {
  checkKey(policy.hmacKey);
  const detector = policy.detector ?? openRedactionDetector();
  const changes: Change[] = [], next: WireMessage = { ...msg };
  const scan = async (text: string, at: string): Promise<string> => {
    if (/^\s*[[{]/.test(text)) {
      try { JSON.parse(text); return await transformJson(text, scan); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    const spans = (await detector.detect(text)).map((d) => ({ start: d.start, end: d.end, replacement: placeholder(text.slice(d.start, d.end), "personal", policy.hmacKey), rule: d.type }));
    const result = applySpans(text, spans);
    changes.push(...result.used.map((s) => ({ at: `${at}:${s.start}`, rule: s.rule })));
    return result.text;
  };
  if (msg.url !== undefined) next.url = await transformUrl(msg.url, scan);
  if (msg.headers) {
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries(msg.headers)) headers[name] = typeof value === "string" ? await scan(value, `headers/${name}`) : await Promise.all(value.map((v) => scan(v, `headers/${name}`)));
    next.headers = headers;
  }
  let originalEncoding: string | undefined;
  if (msg.body !== undefined) {
    if (msg.secrets === "unscanned") {
      delete next.body;
      return { msg: next, changes, unscanned: ["body"], withheld: { size: msg.body.length, reason: "secrets: unscanned" } };
    }
    const bodyChanges = changes.length;
    try {
      const text = bodyText(msg);
      const result = /^application\/x-www-form-urlencoded\b/i.test(msg.contentType ?? "")
        ? await transformForm(text, scan) : await transformText(text, scan);
      if (result !== text) {
        next.body = Buffer.from(result);
        if (msg.contentEncoding && msg.contentEncoding !== "identity") { originalEncoding = msg.contentEncoding; delete next.contentEncoding; }
      }
    } catch {
      changes.length = bodyChanges;
      delete next.body;
      return { msg: next, changes, unscanned: ["body"], withheld: { size: msg.body.length, reason: "Unreadable media or body" } };
    }
  }
  return { msg: next, changes, unscanned: [], ...(originalEncoding ? { originalEncoding } : {}) };
}
