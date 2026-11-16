// One Gmail mailbox, held in memory: messages with their labels and threads, drafts, labels.
// The Gmail connector and the IMAP server both read and change this one mailbox.
import { createHash } from "node:crypto";
import { addresses, buildMessage, decodeWords, header, parts, rfc2822, splitHead } from "./mime.mjs";

const RANK = ["UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM", "DRAFT", "SENT", "CHAT", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "INBOX"];
const rank = id => { const at = RANK.indexOf(id); return at < 0 ? RANK.length : at; };
export const sortLabels = ids => [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));

const escapeHtml = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const htmlText = html => html.replace(/<br\s*\/?>/gi, " ").replace(/<\/(div|p|blockquote|li|tr|h\d)>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
export function snippetOf(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return escapeHtml(flat.length > 200 ? flat.slice(0, 200).replace(/\s+\S*$/, "") : flat);
}

// Fields the connector shows, by message format.
export const META = ["addressDisplayNames", "bccRecipients", "ccRecipients", "date", "historyId", "id", "internalDate", "labelIds", "sender", "sizeEstimate", "threadId", "toRecipients", "viewUrl"];
export const MINIMAL = [...META, "snippet", "subject"];
const BODY_KEYS = ["htmlBody", "plaintextBody"];

export class Mailbox {
  constructor(seed = "") {
    this.account = { email: "", name: "" };
    this.timezone = "UTC";
    this.messages = new Map();
    this.gone = new Set();
    this.threadCounts = new Map();
    this.drafts = new Map();
    this.labels = undefined;
    this.labelDeltas = new Map();
    this.history = 0;
    this.seed = seed;
    this.counter = 0;
    this.changes = [];
  }

  random(bits) {
    const hash = createHash("sha256").update(`${this.seed}:${this.counter++}`).digest();
    return BigInt("0x" + hash.subarray(0, 8).toString("hex")) & ((1n << BigInt(bits)) - 1n);
  }

  newId(nowMs) {
    let id;
    do id = ((BigInt(nowMs) << 20n) | this.random(20)).toString(16); while (this.messages.has(id) || this.gone.has(id));
    return id;
  }

  nextHistory() { this.history += 1 + Number(this.random(6)); return String(this.history); }

  noteHistory(value) { const n = Number(value); if (Number.isFinite(n) && n > this.history) this.history = n; }

  // Adds what an observation says about a message; later observations win for labels and history.
  upsert(fields, { at = 0, know = [] } = {}) {
    const id = fields.id ?? fields.messageId;
    if (!id) return undefined;
    let message = this.messages.get(id);
    if (!message) {
      message = { id, threadId: fields.threadId ?? id, labelIds: [], internalDate: fields.internalDate, historyId: fields.historyId, fields: {}, know: new Set(), observedAt: -1, uids: {} };
      this.messages.set(id, message);
    }
    const { labelIds, historyId, raw, messageFormat: _f, ...rest } = fields;
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) message.fields[key] = value;
    if (fields.threadId) message.threadId = fields.threadId;
    if (fields.internalDate) message.internalDate = fields.internalDate;
    if (raw) message.raw = Buffer.from(raw, "base64url");
    for (const k of know) message.know.add(k);
    if (at >= message.observedAt) {
      if (labelIds) message.labelIds = [...labelIds];
      if (historyId) message.historyId = historyId;
      message.observedAt = at;
    }
    if (historyId) this.noteHistory(historyId);
    return message;
  }

  // Fills connector fields from a stored RFC 822 message when they were never observed.
  fromRaw(message) {
    if (!message.raw) return;
    const { headers } = splitHead(message.raw);
    const from = addresses(header(headers, "from"))[0];
    const leaves = parts(message.raw);
    const text = leaves.find(p => p.type === "text/plain" && p.disposition !== "attachment")?.text;
    const html = leaves.find(p => p.type === "text/html" && p.disposition !== "attachment")?.text;
    const f = message.fields;
    const set = (key, value) => { if (f[key] === undefined && value !== undefined && !(Array.isArray(value) && !value.length)) f[key] = value; };
    if (from) { set("sender", from.email); set("addressDisplayNames", from.name ? [{ displayName: from.name, emailAddress: from.email }] : undefined); }
    set("toRecipients", addresses(header(headers, "to")).map(a => a.email));
    set("ccRecipients", addresses(header(headers, "cc")).map(a => a.email));
    set("subject", decodeWords(header(headers, "subject") ?? ""));
    if (text !== undefined) set("plaintextBody", text.replace(/\r\n/g, "\n"));
    if (html !== undefined) set("htmlBody", html.replace(/\r\n/g, "\n"));
    set("snippet", snippetOf(text ?? htmlText(html ?? "")));
    set("sizeEstimate", message.raw.length);
    if (message.internalDate) set("date", new Date(Number(message.internalDate)).toISOString().replace(".000Z", "Z"));
    for (const k of ["metadata", "minimal", "body", "raw"]) message.know.add(k);
  }

  // How Gmail's API stamps the messages it writes for this account, learned from one it wrote.
  apiStyle() {
    for (const m of this.messages.values()) {
      const head = m.raw?.toString("latin1", 0, 400);
      const found = head && /^Received: from (\S+)\r\n\tnamed unknown\r\n\tby gmailapi\.google\.com[\s\S]*?\r\nDate: [^\r]* ([+-]\d{4})\r\n/.exec(head);
      if (found) return { receivedFrom: found[1], offset: found[2] };
    }
    return {};
  }

  // The RFC 822 form an IMAP client reads. A message seen only through the connector has no
  // stored bytes, so its form is written once from its fields and then kept.
  rawOf(m) {
    if (m.raw) return m.raw;
    const f = m.fields;
    const ms = Number(m.internalDate ?? 0);
    const from = { name: f.addressDisplayNames?.find(a => a.emailAddress === f.sender)?.displayName ?? "", email: f.sender ?? "" };
    const style = from.email === this.account.email ? this.apiStyle() : {};
    m.raw = buildMessage({ from, to: (f.toRecipients ?? []).map(email => ({ name: m.names?.[email] ?? "", email })), cc: (f.ccRecipients ?? []).map(email => ({ name: m.names?.[email] ?? "", email })), subject: f.subject ?? "", text: f.plaintextBody ?? htmlText(f.htmlBody ?? "").trim(), html: f.htmlBody ?? "", date: rfc2822(new Date(ms), this.timezone, m.dateOffset ?? style.offset), messageId: `<${m.id}@mail.gmail.com>`, boundary: `000000000000${m.id}`, receivedFrom: style.receivedFrom });
    m.rawWritten = true;
    return m.raw;
  }

  messageIdOf(m) { return header(splitHead(this.rawOf(m)).headers, "message-id"); }

  // A message an IMAP client stores (APPEND). Gmail keeps one copy per Message-ID.
  receive(raw, { labels = [], seen = false, flagged = false } = {}) {
    const id = header(splitHead(raw).headers, "message-id");
    const same = id && [...this.messages.values()].find(m => m.raw && this.messageIdOf(m) === id);
    if (same) { this.relabel(same, labels); return same; }
    return this.file(raw, [...labels, ...(seen ? [] : ["UNREAD"]), ...(flagged ? ["STARRED"] : [])]);
  }

  // A message sent through SMTP. Gmail adds a Message-ID and a Date, in Pacific time, when the message has none.
  submit(raw, recipients) {
    const given = splitHead(raw).headers, nowMs = this.nowMs ?? Date.now(), added = [];
    if (!header(given, "message-id")) {
      const h = createHash("sha256").update(raw).update(String(nowMs)).digest("hex");
      added.push(`Message-ID: <${h.slice(0, 8)}.${h.slice(8, 16)}.${h.slice(16, 22)}.${h.slice(22, 26)}@mx.google.com>`);
    }
    if (!header(given, "date")) added.push(`Date: ${rfc2822(new Date(nowMs), "America/Los_Angeles")}`);
    if (added.length) raw = Buffer.concat([Buffer.from(added.join("\r\n") + "\r\n", "latin1"), raw]);
    const id = header(splitHead(raw).headers, "message-id");
    const same = id && [...this.messages.values()].find(m => m.raw && this.messageIdOf(m) === id);
    const self = recipients.some(r => r.toLowerCase() === this.account.email.toLowerCase());
    if (same) { this.relabel(same, ["SENT", ...(self ? ["INBOX", "UNREAD"] : [])]); return same.id; }
    const stripped = Buffer.from(raw.toString("latin1").replace(/^Bcc:.*(?:\r\n[ \t].*)*\r\n/im, ""), "latin1");
    return this.file(stripped, ["SENT", ...(self ? ["INBOX", "UNREAD"] : [])]).id;
  }

  file(raw, labels) {
    const { headers } = splitHead(raw);
    const refs = [header(headers, "in-reply-to"), ...(header(headers, "references") ?? "").split(/\s+/)].filter(Boolean);
    const parent = refs.length ? [...this.messages.values()].find(m => (m.raw || m.fields.subject !== undefined) && refs.includes(this.messageIdOf(m))) : undefined;
    const nowMs = this.nowMs ?? Date.now();
    const id = this.newId(nowMs);
    const message = { id, threadId: parent?.threadId ?? id, labelIds: sortLabels(labels), internalDate: String(Math.floor(nowMs / 1000) * 1000), historyId: this.nextHistory(), fields: {}, raw, know: new Set(), observedAt: Infinity, uids: {} };
    this.fromRaw(message);
    this.add(message);
    return message;
  }

  thread(threadId) {
    return [...this.messages.values()].filter(m => m.threadId === threadId && !m.labelIds.includes("DRAFT")).sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  }

  threadComplete(threadId) {
    const count = this.threadCounts.get(threadId);
    return count === undefined ? false : this.thread(threadId).length >= count;
  }

  viewUrl(message) {
    const thread = BigInt("0x" + message.threadId).toString(), msg = BigInt("0x" + message.id).toString();
    return `https://mail.google.com/mail/?authuser=${this.account.email}#all/thread-f:${thread}|msg-f:${msg}`;
  }

  threadUrl(threadId) { return `https://mail.google.com/mail/?authuser=${this.account.email}#all/thread-f:${BigInt("0x" + threadId).toString()}`; }

  draftUrl(draftId, threadId) { return `https://mail.google.com/mail/?authuser=${this.account.email}#all?compose=thread-f:${BigInt("0x" + threadId).toString()}%2Bmsg-a:${draftId}`; }

  // Changes labels and keeps the label counters in step, as Gmail does.
  relabel(message, add = [], remove = []) {
    const before = new Set(message.labelIds);
    const after = new Set([...before].filter(l => !remove.includes(l)));
    for (const l of add) after.add(l);
    const changed = [...after].some(l => !before.has(l)) || [...before].some(l => !after.has(l));
    if (!changed) return false;
    const threadBefore = this.threadLabels(message.threadId);
    const unreadBefore = before.has("UNREAD");
    message.labelIds = sortLabels([...after]);
    message.historyId = this.nextHistory();
    const unreadAfter = after.has("UNREAD");
    for (const l of new Set([...before, ...after])) {
      const d = this.delta(l);
      d.messagesTotal += Number(after.has(l)) - Number(before.has(l));
      d.messagesUnread += Number(after.has(l) && unreadAfter) - Number(before.has(l) && unreadBefore);
    }
    this.countThread(message.threadId, threadBefore);
    if (before.has("DRAFT") !== after.has("DRAFT") && this.threadCounts.has(message.threadId)) this.threadCounts.set(message.threadId, this.threadCounts.get(message.threadId) + (after.has("DRAFT") ? -1 : 1));
    this.changes.push({ id: message.id, labelIds: message.labelIds });
    return true;
  }

  delta(label) {
    if (!this.labelDeltas.has(label)) this.labelDeltas.set(label, { messagesTotal: 0, messagesUnread: 0, threadsTotal: 0, threadsUnread: 0 });
    return this.labelDeltas.get(label);
  }

  threadLabels(threadId) {
    const messages = [...this.messages.values()].filter(m => m.threadId === threadId);
    const all = new Set(messages.flatMap(m => m.labelIds));
    const unread = new Set(messages.filter(m => m.labelIds.includes("UNREAD")).flatMap(m => m.labelIds));
    return { all, unread };
  }

  countThread(threadId, before) {
    const after = this.threadLabels(threadId);
    for (const l of new Set([...before.all, ...after.all])) {
      const d = this.delta(l);
      d.threadsTotal += Number(after.all.has(l)) - Number(before.all.has(l));
      d.threadsUnread += Number(after.unread.has(l)) - Number(before.unread.has(l));
    }
  }

  add(message) {
    const before = this.threadLabels(message.threadId);
    this.messages.set(message.id, message);
    for (const l of message.labelIds) {
      const d = this.delta(l);
      d.messagesTotal++;
      if (message.labelIds.includes("UNREAD")) d.messagesUnread++;
    }
    this.countThread(message.threadId, before);
    const draft = message.labelIds.includes("DRAFT");
    if (this.threadCounts.has(message.threadId) || message.threadId === message.id) this.threadCounts.set(message.threadId, (this.threadCounts.get(message.threadId) ?? 0) + (draft ? 0 : 1));
    this.changes.push({ id: message.id, added: true });
  }

  remove(message) {
    const before = this.threadLabels(message.threadId);
    this.messages.delete(message.id);
    this.gone.add(message.id);
    for (const l of message.labelIds) {
      const d = this.delta(l);
      d.messagesTotal--;
      if (message.labelIds.includes("UNREAD")) d.messagesUnread--;
    }
    this.countThread(message.threadId, before);
    if (!message.labelIds.includes("DRAFT") && this.threadCounts.has(message.threadId)) this.threadCounts.set(message.threadId, this.threadCounts.get(message.threadId) - 1);
    this.changes.push({ id: message.id, removed: true });
  }

  // Gmail numbers labels made through its API Label_1, Label_2, ... and lists user labels by id.
  addLabel(label) {
    const n = /^Label_(\d{1,9})$/.exec(label.labelId)?.[1];
    if (n) this.labelCounter = Math.max(this.labelCounter ?? 0, Number(n));
    const all = [...(this.labels ?? []).filter(l => l.labelId !== label.labelId), label];
    this.labels = [...all.filter(l => l.labelType !== "USER"), ...all.filter(l => l.labelType === "USER").sort((a, b) => a.labelId < b.labelId ? -1 : a.labelId > b.labelId ? 1 : 0)];
    return label;
  }

  highestLabel() {
    this.labelCounter ??= Math.max(0, ...this.labels.map(l => Number(/^Label_(\d{1,9})$/.exec(l.labelId)?.[1] ?? 0)));
    return this.labelCounter;
  }

  createLabel(name, { labelListVisibility = "LABEL_SHOW", messageListVisibility = "SHOW" } = {}) {
    return this.addLabel({ labelId: `Label_${this.highestLabel() + 1}`, labelListVisibility, labelType: "USER", messageListVisibility, messagesTotal: 0, messagesUnread: 0, name, threadsTotal: 0, threadsUnread: 0 });
  }

  deleteLabel(labelId) {
    this.highestLabel();
    for (const m of this.messages.values()) if (m.labelIds.includes(labelId)) this.relabel(m, [], [labelId]);
    this.labels = this.labels.filter(l => l.labelId !== labelId);
    this.labelDeltas.delete(labelId);
  }

  labelId(nameOrId) {
    const wanted = nameOrId.toLowerCase().replace(/[-_ ]/g, "");
    const known = this.labels?.find(l => l.labelId.toLowerCase() === nameOrId.toLowerCase() || l.name.toLowerCase().replace(/[-_ /]/g, "") === wanted.replace(/\//g, ""));
    return known?.labelId ?? nameOrId.toUpperCase();
  }

  state() {
    return {
      account: this.account.email ? { email: this.account.email } : {},
      messages: [...this.messages.values()].sort((a, b) => a.id < b.id ? -1 : 1).map(m => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, subject: m.fields.subject ?? null })),
      drafts: [...this.drafts.entries()].map(([id, messageId]) => ({ id, messageId })),
      changes: this.changes,
    };
  }
}

// Gmail search over the messages the copy holds. Search ranking and spam rules live on Google's
// servers, so results hold only messages the copy knows, newest thread first.
const words = text => (text ?? "").toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) ?? [];
const contains = (haystack, needle) => {
  const h = words(haystack), n = words(needle);
  if (!n.length) return true;
  for (let i = 0; i + n.length <= h.length; i++) if (n.every((w, j) => h[i + j] === w)) return true;
  return false;
};

function tokenize(query) {
  const tokens = [];
  const re = /\s*(\(|\)|\{|\}|-?[A-Za-z_]+:"[^"]*"|-?[A-Za-z_]+:\([^)]*\)|-?"[^"]*"|-?[^\s(){}]+)/g;
  let m;
  while ((m = re.exec(query))) tokens.push(m[1]);
  return tokens;
}

export function compileQuery(query, mailbox, nowMs) {
  const tokens = tokenize(query ?? "");
  let i = 0;
  const parseOr = () => {
    const options = [parseAnd()];
    while (tokens[i] === "OR") { i++; options.push(parseAnd()); }
    return options.length === 1 ? options[0] : m => options.some(f => f(m));
  };
  const parseAnd = () => {
    const all = [];
    while (i < tokens.length && tokens[i] !== ")" && tokens[i] !== "}" && tokens[i] !== "OR") all.push(parseTerm());
    return m => all.every(f => f(m));
  };
  const parseTerm = () => {
    const t = tokens[i++];
    if (t === "(") { const f = parseOr(); if (tokens[i] === ")") i++; return f; }
    if (t === "{") { const options = []; while (i < tokens.length && tokens[i] !== "}") options.push(parseTerm()); i++; return m => options.some(f => f(m)); }
    if (t.startsWith("-") && t.length > 1) { tokens[--i] = t.slice(1); const f = parseTerm(); return m => !f(m); }
    return term(t);
  };
  const date = value => { const [y, mo, d] = value.split(/[/-]/).map(Number); return Date.UTC(y, (mo ?? 1) - 1, d ?? 1); };
  const age = value => { const n = Number(value.slice(0, -1)), unit = value.at(-1); return n * ({ d: 86400e3, m: 30 * 86400e3, y: 365 * 86400e3, h: 3600e3 }[unit] ?? 86400e3); };
  const people = (m, keys) => keys.flatMap(k => { const v = m.fields[k]; return Array.isArray(v) ? v : v ? [v] : []; }).concat(keys.includes("sender") ? (m.fields.addressDisplayNames ?? []).map(a => a.displayName) : []).join(" ");
  let unknown = false;
  const text = (m, haystack, value) => {
    if (contains(haystack, value)) return true;
    if (!m.know.has("body") && !(m.raw && !m.rawWritten)) unknown = true;
    return false;
  };
  const term = t => {
    const op = /^([A-Za-z_]+):(.*)$/.exec(t);
    const value = op ? op[2].replace(/^"(.*)"$/, "$1").replace(/^\((.*)\)$/, "$1") : t.replace(/^"(.*)"$/, "$1");
    if (!op) return m => text(m, [m.fields.subject, m.fields.plaintextBody ?? htmlText(m.fields.htmlBody ?? ""), m.fields.snippet, people(m, ["sender", "toRecipients", "ccRecipients"])].join(" "), value);
    const key = op[1].toLowerCase();
    const v = value.toLowerCase();
    const has = l => m => m.labelIds.includes(l);
    switch (key) {
      case "subject": return m => contains(m.fields.subject, value);
      case "from": return m => v === "me" ? m.fields.sender === mailbox.account.email : contains(people(m, ["sender"]), value) || (m.fields.sender ?? "").toLowerCase().includes(v);
      case "to": return m => v === "me" ? (m.fields.toRecipients ?? []).includes(mailbox.account.email) : (m.fields.toRecipients ?? []).some(a => a.toLowerCase().includes(v));
      case "cc": return m => (m.fields.ccRecipients ?? []).some(a => a.toLowerCase().includes(v));
      case "bcc": return m => (m.fields.bccRecipients ?? []).some(a => a.toLowerCase().includes(v));
      case "in": return v === "anywhere" ? () => true : v === "drafts" ? has("DRAFT") : has({ inbox: "INBOX", sent: "SENT", trash: "TRASH", spam: "SPAM", starred: "STARRED", important: "IMPORTANT", chats: "CHAT" }[v] ?? mailbox.labelId(value));
      case "is": return v === "read" ? m => !m.labelIds.includes("UNREAD") : has({ unread: "UNREAD", starred: "STARRED", important: "IMPORTANT", draft: "DRAFT", sent: "SENT" }[v] ?? v.toUpperCase());
      case "label": return has(mailbox.labelId(value));
      case "category": return has(`CATEGORY_${v === "primary" ? "PERSONAL" : v.toUpperCase()}`);
      case "has": return v === "attachment" ? m => (m.fields.attachments?.length ?? 0) > 0 : () => false;
      case "after": return m => Number(m.internalDate) >= date(value);
      case "before": return m => Number(m.internalDate) < date(value);
      case "newer_than": return m => Number(m.internalDate) >= nowMs - age(v);
      case "older_than": return m => Number(m.internalDate) < nowMs - age(v);
      case "filename": return m => (m.fields.attachments ?? []).some(a => (a.filename ?? "").toLowerCase().includes(v));
      default: return m => text(m, JSON.stringify(m.fields), value);
    }
  };
  const f = tokens.length ? parseOr() : () => true;
  const mentionsBin = /\bin:(trash|spam|anywhere)\b/i.test(query ?? "") || /\blabel:(trash|spam)\b/i.test(query ?? "");
  return { match: f, mentionsBin, unknown: () => unknown };
}

export const knowsFor = format => format === "RAW" ? "raw" : format === "METADATA_ONLY" ? "metadata" : format === "MINIMAL" ? "minimal" : "body";
export const keysFor = format => format === "METADATA_ONLY" ? META : format === "MINIMAL" ? MINIMAL : format === "RAW" ? ["historyId", "id", "internalDate", "labelIds", "raw", "sizeEstimate", "threadId", "viewUrl"] : null;
export { BODY_KEYS };
