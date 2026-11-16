// The claude.ai Gmail connector's tools, answered from the mailbox. Reads render the same JSON the
// connector returns (keys sorted, compact). Writes change the mailbox the way Gmail does.
import { buildMessage, rfc2822 } from "./mime.mjs";
import { BODY_KEYS, compileQuery, htmlText, keysFor, knowsFor, snippetOf, sortLabels } from "./mailbox.mjs";

export const READ_ONLY = ["search_threads", "get_thread", "get_message", "list_labels", "list_drafts", "get_draft", "download_gmail_attachment"];
export const TOOLS = [...READ_ONLY, "send_message", "reply", "forward", "create_draft", "update_draft", "delete_draft", "label_message", "unlabel_message", "label_thread", "unlabel_thread", "update_message_labels", "trash_message", "untrash_message", "trash_thread", "untrash_thread", "mark_message_spam", "unmark_message_spam", "mark_thread_spam", "unmark_thread_spam", "apply_sensitive_message_label", "apply_sensitive_thread_label", "create_label", "update_label", "delete_label"];

export class Unsupported extends Error {}
export class ToolError extends Error {}

const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
const decodeEntities = text => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const textOfHtml = html => decodeEntities(htmlText(html));
const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const LEVELS = ["metadata", "minimal", "body"];
const knows = (message, level) => level === "raw" ? !!message.raw : LEVELS.slice(LEVELS.indexOf(level)).some(l => message.know.has(l));

export class Connector {
  constructor(mailbox) { this.box = mailbox; }

  message(id) {
    const m = this.box.messages.get(id);
    if (m) return m;
    if (this.box.gone.has(id)) throw new ToolError("Requested entity was not found.");
    throw new Unsupported(`message ${id} is not in the copy`);
  }

  // A record in a folder the copy can't settle may be another record's message, so it is not shown.
  settled(m) {
    const unsettled = this.box.unsettled ?? new Set();
    const inTrash = m.labelIds.includes("TRASH") || m.labelIds.includes("SPAM");
    if (m.ambiguous || (unsettled.has(null) && !inTrash) || m.labelIds.some(l => unsettled.has(l))) throw new Unsupported(`the copy can't tell whether message ${m.id} is the same as another of its records`);
  }

  render(m, format = "PLAIN_TEXT") {
    this.settled(m);
    const level = knowsFor(format);
    if (!knows(m, level)) throw new Unsupported(`the copy does not hold the ${format} form of message ${m.id}`);
    const full = { ...m.fields, id: m.id, threadId: m.threadId, labelIds: m.labelIds, historyId: m.historyId, internalDate: m.internalDate, viewUrl: m.fields.viewUrl ?? this.box.viewUrl(m), ...(format === "RAW" ? { raw: m.raw.toString("base64url") } : {}) };
    delete full.messageId;
    const keys = keysFor(format) ?? Object.keys(full).filter(k => k !== "raw");
    return sorted(Object.fromEntries(keys.filter(k => full[k] !== undefined).map(k => [k, full[k]])));
  }

  threadView(threadId, format, subset) {
    const messages = this.box.thread(threadId);
    const shown = subset ? messages.slice(-subset) : messages;
    return { id: threadId, messageCount: messages.length, messages: shown.map(m => format === "IDS" ? { id: m.id } : this.render(m, format)), viewUrl: this.box.threadUrl(threadId) };
  }

  call(tool, args, nowMs) {
    const a = args ?? {};
    switch (tool) {
      case "get_message": return this.render(this.message(a.messageId), a.messageFormat === "MESSAGE_FORMAT_UNSPECIFIED" ? "PLAIN_TEXT" : a.messageFormat);
      case "get_thread": {
        if (!this.box.thread(a.threadId).length) { if ([...this.box.gone].length && !this.box.threadCounts.has(a.threadId)) throw new Unsupported(`thread ${a.threadId} is not in the copy`); throw new Unsupported(`thread ${a.threadId} is not in the copy`); }
        if (!this.box.threadComplete(a.threadId)) throw new Unsupported(`the copy holds only part of thread ${a.threadId}`);
        return sorted(this.threadView(a.threadId, a.messageFormat && a.messageFormat !== "MESSAGE_FORMAT_UNSPECIFIED" ? a.messageFormat : "PLAIN_TEXT"));
      }
      case "search_threads": return this.search(a, nowMs);
      case "list_labels": return this.listLabels();
      case "list_drafts": return this.listDrafts(a, nowMs);
      case "get_draft": return this.draftView(a.draftId, a.messageFormat === "METADATA_ONLY" ? "metadata" : "full");
      case "download_gmail_attachment": throw new Unsupported("attachment bytes are not held by the copy");
      case "update_message_labels": {
        const m = this.message(a.messageId);
        this.box.relabel(m, (a.addLabelIds ?? []).map(l => this.box.labelId(l)), (a.removeLabelIds ?? []).map(l => this.box.labelId(l)));
        return { labelIds: m.labelIds, messageId: m.id };
      }
      case "label_message": this.box.relabel(this.message(a.messageId), a.labelIds.map(l => this.box.labelId(l))); return {};
      case "unlabel_message": this.box.relabel(this.message(a.messageId), [], a.labelIds.map(l => this.box.labelId(l))); return {};
      case "label_thread": for (const m of this.threadMessages(a.threadId)) this.box.relabel(m, a.labelIds.map(l => this.box.labelId(l))); return {};
      case "unlabel_thread": for (const m of this.threadMessages(a.threadId)) this.box.relabel(m, [], a.labelIds.map(l => this.box.labelId(l))); return {};
      case "trash_message": this.box.relabel(this.message(a.messageId), ["TRASH"], ["INBOX"]); return {};
      case "untrash_message": this.box.relabel(this.message(a.messageId), [], ["TRASH"]); return {};
      case "trash_thread": for (const m of this.threadMessages(a.threadId)) this.box.relabel(m, ["TRASH"], ["INBOX"]); return {};
      case "untrash_thread": for (const m of this.threadMessages(a.threadId)) this.box.relabel(m, [], ["TRASH"]); return {};
      case "mark_message_spam": this.box.relabel(this.message(a.messageId), ["SPAM"], ["INBOX"]); return {};
      case "unmark_message_spam": this.box.relabel(this.message(a.messageId), ["INBOX"], ["SPAM"]); return {};
      case "mark_thread_spam": for (const m of this.threadMessages(a.threadId)) this.box.relabel(m, ["SPAM"], ["INBOX"]); return {};
      case "unmark_thread_spam": for (const m of this.threadMessages(a.threadId)) this.box.relabel(m, ["INBOX"], ["SPAM"]); return {};
      case "apply_sensitive_message_label": this.box.relabel(this.message(a.messageId), [a.labelOption], ["INBOX"]); return {};
      case "apply_sensitive_thread_label": for (const m of this.threadMessages(a.threadId)) this.box.relabel(m, [a.labelOption], ["INBOX"]); return {};
      case "create_label": {
        if (!this.box.labels) throw new Unsupported("the copy never saw the label list");
        if ((a.colorPreset && a.colorPreset !== "LABEL_COLOR_PRESET_UNSPECIFIED") || a.color || String(a.displayName ?? "").includes("/")) throw new Unsupported("the copy answers only plain, unnested labels without a color");
        if (this.box.labels.some(l => l.name.toLowerCase() === String(a.displayName ?? "").toLowerCase())) throw new Unsupported(`a label named ${a.displayName} already exists`);
        const visible = v => v && !v.endsWith("_UNSPECIFIED") ? v : undefined;
        const l = this.box.createLabel(a.displayName, { labelListVisibility: visible(a.labelListVisibility), messageListVisibility: visible(a.messageListVisibility) });
        return sorted({ color: {}, labelId: l.labelId, labelListVisibility: l.labelListVisibility, messageListVisibility: l.messageListVisibility, name: l.name });
      }
      case "update_label": {
        const l = this.userLabel(a.labelId);
        if ((a.colorPreset && a.colorPreset !== "LABEL_COLOR_PRESET_UNSPECIFIED") || a.color || String(a.displayName ?? "").includes("/")) throw new Unsupported("the copy answers only renames and visibility changes");
        if (a.displayName !== undefined && this.box.labels.some(x => x !== l && x.name.toLowerCase() === String(a.displayName).toLowerCase())) throw new Unsupported(`a label named ${a.displayName} already exists`);
        const out = { labelId: l.labelId };
        if (a.displayName !== undefined) l.name = out.name = a.displayName;
        for (const k of ["labelListVisibility", "messageListVisibility"]) if (a[k] && !a[k].endsWith("_UNSPECIFIED")) l[k] = out[k] = a[k];
        return sorted(out);
      }
      case "delete_label": this.box.deleteLabel(this.userLabel(a.labelId).labelId); return {};
      case "send_message": return this.send(a, nowMs);
      case "reply": return this.reply(a, nowMs);
      case "forward": return this.forward(a, nowMs);
      case "create_draft": return this.createDraft(a, nowMs);
      case "update_draft": return this.updateDraft(a, nowMs);
      case "delete_draft": {
        const messageId = this.box.drafts.get(a.draftId);
        if (!messageId) throw new Unsupported(`draft ${a.draftId} is not in the copy`);
        this.box.drafts.delete(a.draftId);
        const m = this.box.messages.get(messageId);
        if (m) this.box.remove(m);
        return {};
      }
      default: throw new Unsupported(`the copy does not answer ${tool}`);
    }
  }

  userLabel(labelId) {
    const l = this.box.labels?.find(x => x.labelId === labelId);
    if (!l || l.labelType !== "USER") throw new Unsupported(`label ${labelId} is not a user label the copy holds`);
    return l;
  }

  threadMessages(threadId) {
    const messages = [...this.box.messages.values()].filter(m => m.threadId === threadId);
    if (!messages.length || !this.box.threadComplete(threadId)) throw new Unsupported(`the copy does not hold all of thread ${threadId}`);
    return messages;
  }

  search(a, nowMs) {
    const { match, mentionsBin, unknown } = compileQuery(a.query ?? "", this.box, nowMs);
    const visible = m => !m.labelIds.includes("DRAFT") && (a.includeTrash || mentionsBin || (!m.labelIds.includes("TRASH") && !m.labelIds.includes("SPAM")));
    const threads = new Map();
    for (const m of this.box.messages.values()) {
      if (!visible(m) || !match(m)) continue;
      if (!knows(m, "minimal")) throw new Unsupported(`the copy cannot show message ${m.id}, which the query matches`);
      threads.set(m.threadId, Math.max(threads.get(m.threadId) ?? 0, Number(m.internalDate ?? 0)));
    }
    if (unknown()) throw new Unsupported("the query searches text of messages whose content the copy does not hold");
    const order = [...threads.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    if (!order.length) return {};
    const size = Math.min(a.pageSize ?? 20, 50), start = a.pageToken ? Number(Buffer.from(a.pageToken, "base64url").toString()) : 0;
    const page = order.slice(start, start + size);
    const view = a.view && a.view !== "THREAD_VIEW_UNSPECIFIED" ? a.view : "THREAD_VIEW_MINIMAL";
    const format = { THREAD_VIEW_MINIMAL: "MINIMAL", THREAD_VIEW_METADATA_ONLY: "METADATA_ONLY", THREAD_VIEW_SUMMARY: "MINIMAL", THREAD_VIEW_IDS_ONLY: "IDS" }[view];
    const out = { resultCountEstimate: String(order.length), threads: page.map(id => view === "THREAD_VIEW_IDS_ONLY" ? { id } : this.threadView(id, format, view === "THREAD_VIEW_SUMMARY" ? 1 : 5)) };
    if (start + size < order.length) out.nextPageToken = Buffer.from(String(start + size)).toString("base64url");
    return sorted(out);
  }

  listLabels() {
    if (!this.box.labels) throw new Unsupported("the copy never saw the label list");
    const known = this.box.labels.map(l => {
      const d = this.box.labelDeltas.get(l.labelId);
      if (!d || l.messagesTotal === undefined) return l;
      return { ...l, messagesTotal: l.messagesTotal + d.messagesTotal, messagesUnread: l.messagesUnread + d.messagesUnread, threadsTotal: l.threadsTotal + d.threadsTotal, threadsUnread: l.threadsUnread + d.threadsUnread };
    });
    return sorted({ labels: known });
  }

  draftMessage(draftId) {
    const messageId = this.box.drafts.get(draftId);
    const m = messageId && this.box.messages.get(messageId);
    if (!m) throw new Unsupported(`draft ${draftId} is not in the copy`);
    return m;
  }

  draftView(draftId, view) {
    const m = this.draftMessage(draftId);
    this.settled(m);
    if (view !== "metadata" && !knows(m, "body")) throw new Unsupported(`the copy does not hold the body of draft ${draftId}`);
    const f = m.fields;
    const out = { date: f.date, id: draftId, labelIds: m.labelIds, messageId: m.id, sender: f.sender, threadId: m.threadId, toRecipients: f.toRecipients, ccRecipients: f.ccRecipients, bccRecipients: f.bccRecipients, viewUrl: this.box.draftUrl(draftId, m.threadId) };
    if (view !== "metadata") Object.assign(out, { htmlBody: f.htmlBody, plaintextBody: f.plaintextBody, snippet: f.snippet, subject: f.subject });
    return sorted(Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length && v !== m.labelIds))));
  }

  listDrafts(a, nowMs) {
    const { match } = compileQuery(a.query ?? "", this.box, nowMs);
    const drafts = [...this.box.drafts.entries()].map(([id, messageId]) => [id, this.box.messages.get(messageId)]).filter(([, m]) => m && match(m));
    if (!drafts.length) return {};
    drafts.sort((x, y) => Number(y[1].internalDate) - Number(x[1].internalDate));
    return sorted({ drafts: drafts.slice(0, Math.min(a.pageSize ?? 20, 50)).map(([id]) => this.draftView(id, a.view === "DRAFT_VIEW_FULL" ? "full" : "metadata")) });
  }

  // --- messages the copy writes, shaped like the ones Gmail writes ---
  person() { return { name: this.box.account.name, email: this.box.account.email }; }
  quoteDate(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: this.box.timezone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return `${p.weekday}, ${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute} ${p.dayPeriod}`;
  }
  quote(original) {
    const name = original.fields.addressDisplayNames?.find(x => x.emailAddress === original.fields.sender)?.displayName ?? original.fields.sender;
    const inner = original.fields.htmlBody ? (/<body>([\s\S]*)<\/body>/.exec(original.fields.htmlBody)?.[1] ?? original.fields.htmlBody).replace(/<br\/>/g, "<br>") : escape(original.fields.plaintextBody ?? "").replace(/\n/g, "<br>");
    return `<br><div class="gmail_extra"><div>On ${this.quoteDate(Number(original.internalDate))}, ${name} &lt;${original.fields.sender}&gt; wrote:<br><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;"><div>${inner}</div></blockquote></div></div>`;
  }

  compose({ to = [], cc = [], bcc = [], subject = "", body, htmlBody, threadId, labelIds, nowMs, html, plain = true, inReplyTo }) {
    const id = this.box.newId(nowMs);
    const internalDate = String(Math.floor(nowMs / 1000) * 1000);
    const markup = html ?? htmlBody ?? `<html><body><div dir="auto">${escape(body ?? "").replace(/\n/g, "<br/>")}</div></body></html>`;
    const me = this.person();
    const style = this.box.apiStyle();
    const digits = (n, bits) => String(this.box.random(bits)).padStart(n, "0").slice(-n);
    const token = Buffer.from(this.box.random(63).toString(16).padStart(16, "0").repeat(2), "hex").toString("base64").replace(/=+$/, "").slice(0, 21) + Buffer.from(this.box.random(63).toString(16).padStart(16, "0").repeat(2), "hex").toString("base64").replace(/=+$/, "").slice(0, 21);
    const raw = buildMessage({ from: me, to: to.map(email => ({ name: "", email })), cc: cc.map(email => ({ name: "", email })), subject, text: plain ? body ?? textOfHtml(markup) : undefined, html: markup, date: rfc2822(new Date(nowMs), this.box.timezone, style.offset), messageId: `<CA${token}@mail.gmail.com>`, inReplyTo, boundary: `----=_Part_${digits(6, 20)}_${digits(10, 34)}.${nowMs}`, receivedFrom: style.receivedFrom });
    const fields = {
      addressDisplayNames: me.name ? [{ displayName: me.name, emailAddress: me.email }] : undefined,
      date: iso(Number(internalDate)), htmlBody: markup, plaintextBody: plain && body !== undefined ? body : undefined, sender: me.email,
      sizeEstimate: raw.length, snippet: snippetOf(textOfHtml(markup)), subject,
      toRecipients: to.length ? to : undefined, ccRecipients: cc.length ? cc : undefined, bccRecipients: bcc.length ? bcc : undefined,
    };
    const message = { id, threadId: threadId ?? id, labelIds: sortLabels(labelIds), internalDate, historyId: this.box.nextHistory(), fields, raw, know: new Set(["metadata", "minimal", "body", "raw"]), observedAt: Infinity, uids: {} };
    this.box.add(message);
    return message;
  }

  sentLabels(to, cc, bcc) { return [...to, ...cc, ...bcc].some(a => a.toLowerCase() === this.box.account.email.toLowerCase()) ? ["UNREAD", "SENT", "INBOX"] : ["SENT"]; }
  link(m, extra = {}) { return sorted({ id: m.id, threadId: m.threadId, viewUrl: this.box.viewUrl(m), ...extra }); }

  send(a, nowMs) {
    if (a.draftId) {
      const m = this.draftMessage(a.draftId);
      this.box.drafts.delete(a.draftId);
      const labels = this.sentLabels(m.fields.toRecipients ?? [], m.fields.ccRecipients ?? [], m.fields.bccRecipients ?? []);
      this.box.relabel(m, labels, ["DRAFT"]);
      return this.link(m, { labelIds: m.labelIds });
    }
    const [to, cc, bcc] = [a.to ?? [], a.cc ?? [], a.bcc ?? []];
    const thread = a.replyThreadId ?? (a.replyToMessageId ? this.message(a.replyToMessageId).threadId : undefined);
    const m = this.compose({ to, cc, bcc, subject: a.subject ?? "", body: a.body, htmlBody: a.htmlBody, threadId: thread, labelIds: this.sentLabels(to, cc, bcc), nowMs });
    return this.link(m);
  }

  replyTargets(original, a) {
    const me = this.box.account.email;
    if (a.to?.length) return a.to;
    const from = original.fields.sender;
    const to = from === me ? original.fields.toRecipients ?? [] : [from];
    return a.replyAll ? [...new Set([...to, ...(original.fields.toRecipients ?? []), ...(original.fields.ccRecipients ?? [])].filter(x => x !== me || to.includes(x)))] : to;
  }

  reply(a, nowMs) {
    const original = this.message(a.messageId);
    if (!knows(original, "body")) throw new Unsupported(`the copy does not hold the body of message ${a.messageId}`);
    const to = this.replyTargets(original, a);
    const subject = /^re:/i.test(original.fields.subject ?? "") ? original.fields.subject : `Re: ${original.fields.subject ?? ""}`;
    const html = `${a.htmlBody ?? `<html><body><div dir="auto">${escape(a.body ?? "").replace(/\n/g, "<br/>")}</div></body></html>`}${this.quote(original)}`;
    const m = this.compose({ to, cc: a.cc ?? [], bcc: a.bcc ?? [], subject, body: a.body, html, plain: false, threadId: original.threadId, labelIds: this.sentLabels(to, a.cc ?? [], a.bcc ?? []), nowMs, inReplyTo: original.id });
    return this.link(m);
  }

  forward(a, nowMs) {
    const original = this.message(a.messageId);
    if (!knows(original, "body")) throw new Unsupported(`the copy does not hold the body of message ${a.messageId}`);
    const subject = /^fwd:/i.test(original.fields.subject ?? "") ? original.fields.subject : `Fwd: ${original.fields.subject ?? ""}`;
    const html = `${a.htmlBody ?? `<html><body><div dir="auto">${escape(a.forwardText ?? "").replace(/\n/g, "<br/>")}</div></body></html>`}${this.quote(original)}`;
    const m = this.compose({ to: a.to ?? [], cc: a.cc ?? [], bcc: a.bcc ?? [], subject, body: a.forwardText, html, plain: false, threadId: original.threadId, labelIds: this.sentLabels(a.to ?? [], a.cc ?? [], a.bcc ?? []), nowMs });
    return this.link(m);
  }

  createDraft(a, nowMs) {
    const original = a.replyToMessageId ? this.message(a.replyToMessageId) : undefined;
    const html = original ? `${a.htmlBody ?? `<html><body><div dir="auto">${escape(a.body ?? "").replace(/\n/g, "<br/>")}</div></body></html>`}${this.quote(original)}` : undefined;
    const m = this.compose({ to: a.to ?? [], cc: a.cc ?? [], bcc: a.bcc ?? [], subject: a.subject ?? "", body: a.body, htmlBody: a.htmlBody, html, plain: !original, threadId: original?.threadId, labelIds: ["DRAFT"], nowMs });
    const draftId = `r${this.box.random(63)}`;
    this.box.drafts.set(draftId, m.id);
    m.replyTo = original?.id;
    return sorted({ id: draftId, messageId: m.id, threadId: m.threadId, viewUrl: this.box.draftUrl(draftId, m.threadId) });
  }

  updateDraft(a, nowMs) {
    const old = this.draftMessage(a.draftId);
    const original = old.replyTo ? this.box.messages.get(old.replyTo) : undefined;
    const body = a.body ?? old.fields.plaintextBody;
    const keep = a.body === undefined && a.htmlBody === undefined ? old.fields.htmlBody : undefined;
    const html = keep ?? (original ? `<html><body><div dir="auto">${escape(body ?? "").replace(/\n/g, "<br/>")}</div>${this.quote(original)}</body></html>` : undefined);
    this.box.remove(old);
    this.box.gone.delete(old.id);
    const m = this.compose({ to: a.to ?? old.fields.toRecipients ?? [], cc: a.cc ?? old.fields.ccRecipients ?? [], bcc: a.bcc ?? old.fields.bccRecipients ?? [], subject: a.subject ?? old.fields.subject ?? "", body, htmlBody: a.htmlBody, html, threadId: old.threadId, labelIds: ["DRAFT"], nowMs });
    m.replyTo = old.replyTo;
    this.box.drafts.set(a.draftId, m.id);
    return sorted({ id: a.draftId, messageId: m.id, threadId: m.threadId, viewUrl: this.box.draftUrl(a.draftId, m.threadId) });
  }

  // A message the copy wrote for a recorded past write takes the id the real service gave it.
  // Gmail ids carry the millisecond the message was made, and its internalDate is that second.
  adopt(ours, theirs) {
    const m = this.box.messages.get(ours);
    if (!m || ours === theirs) return;
    this.box.messages.delete(ours);
    this.box.gone.delete(ours);
    m.id = theirs;
    if (m.threadId === ours) {
      m.threadId = theirs;
      if (this.box.threadCounts.has(ours)) { this.box.threadCounts.set(theirs, this.box.threadCounts.get(ours)); this.box.threadCounts.delete(ours); }
    }
    if (/^[0-9a-f]{16}$/.test(theirs)) {
      m.internalDate = String(Number(BigInt("0x" + theirs) >> 20n) / 1000 | 0) + "000";
      m.fields.date = iso(Number(m.internalDate));
    }
    this.box.messages.set(theirs, m);
  }

  // Moves one message to another thread. Thread counts (drafts not counted) follow that message only.
  rethread(m, threadId) {
    if (!threadId || m.threadId === threadId) return;
    const counts = this.box.threadCounts, from = m.threadId, weight = m.labelIds.includes("DRAFT") ? 0 : 1;
    const alone = !this.box.thread(from).some(o => o !== m);
    if (counts.has(threadId)) counts.set(threadId, counts.get(threadId) + weight);
    else if (!this.box.thread(threadId).length && (threadId === m.id || (alone && counts.has(from)))) counts.set(threadId, alone && counts.has(from) ? counts.get(from) : weight);
    if (alone) counts.delete(from);
    else if (counts.has(from)) counts.set(from, counts.get(from) - weight);
    m.threadId = threadId;
  }

  // What the copy made for a write takes the ids in the real answer to that write, so later calls by
  // those ids reach it. Returns the copy's answer with those ids.
  takeIds(tool, made, real) {
    if (!made || !real || typeof real !== "object") return made;
    if (["send_message", "reply", "forward"].includes(tool) && real.id && made.id && (real.id === made.id || !this.box.messages.has(real.id))) {
      const m = this.box.messages.get(made.id);
      this.adopt(made.id, real.id);
      this.rethread(m, real.threadId);
      return this.link(m, made.labelIds ? { labelIds: m.labelIds } : {});
    }
    const draftId = tool === "create_draft" && real.id ? real.id : made.id;
    if ((tool === "create_draft" || tool === "update_draft") && real.messageId && made.messageId && (real.messageId === made.messageId || !this.box.messages.has(real.messageId)) && (draftId === made.id || !this.box.drafts.has(draftId))) {
      const m = this.box.messages.get(made.messageId);
      this.box.drafts.delete(made.id);
      this.adopt(made.messageId, real.messageId);
      this.rethread(m, real.threadId);
      this.box.drafts.set(draftId, m.id);
      return sorted({ id: draftId, messageId: m.id, threadId: m.threadId, viewUrl: this.box.draftUrl(draftId, m.threadId) });
    }
    if (tool === "create_label" && real.labelId && made.labelId && real.labelId !== made.labelId && !this.box.labels.some(l => l.labelId === real.labelId)) {
      const l = this.box.labels.find(x => x.labelId === made.labelId);
      this.box.labels = this.box.labels.filter(x => x !== l);
      this.box.addLabel({ ...l, labelId: real.labelId });
      return sorted({ ...made, labelId: real.labelId });
    }
    return made;
  }

  // Learns the mailbox from one recorded connector answer.
  ingest(tool, args, value, at, past) {
    const a = args ?? {};
    const level = f => knowsFor(f && f !== "MESSAGE_FORMAT_UNSPECIFIED" ? f : "PLAIN_TEXT");
    const learnAccount = url => { const m = /authuser=([^#&]+)/.exec(url ?? ""); if (m && !this.box.account.email) this.box.account.email = decodeURIComponent(m[1]); };
    const learn = (fields, know) => {
      learnAccount(fields.viewUrl);
      if (!past && this.box.messages.has(fields.id)) return;
      const m = this.box.upsert(fields, { at, know: [know] });
      const me = fields.addressDisplayNames?.find(x => x.emailAddress === this.box.account.email);
      if (me && !this.box.account.name) this.box.account.name = me.displayName;
      return m;
    };
    if (!value || typeof value !== "object") return;
    switch (tool) {
      case "get_message": learn(value, level(a.messageFormat)); break;
      case "get_thread": for (const m of value.messages ?? []) learn(m, level(a.messageFormat)); if (value.id) this.box.threadCounts.set(value.id, value.messageCount); break;
      case "search_threads":
        for (const t of value.threads ?? []) {
          if (t.messageCount !== undefined) this.box.threadCounts.set(t.id, t.messageCount);
          for (const m of t.messages ?? []) if (m.threadId) learn(m, a.view === "THREAD_VIEW_METADATA_ONLY" ? "metadata" : "minimal");
        }
        break;
      case "list_labels": if (Array.isArray(value.labels)) this.box.labels = value.labels; break;
      case "list_drafts": case "get_draft":
        for (const d of tool === "get_draft" ? [value] : value.drafts ?? []) {
          if (!d.id || !d.messageId) continue;
          if (past || !this.box.drafts.has(d.id)) this.box.drafts.set(d.id, d.messageId);
          const { id, messageId, viewUrl: _v, ...rest } = d;
          learn({ ...rest, id: messageId }, tool === "get_draft" || a.view === "DRAFT_VIEW_FULL" ? "body" : "metadata");
        }
        break;
      default: {
        if (!past) break;
        if (tool === "update_message_labels" && value.messageId) { const m = this.box.messages.get(value.messageId); if (m) m.labelIds = value.labelIds; break; }
        if (["send_message", "reply", "forward"].includes(tool) && value.id && !this.box.messages.has(value.id)) {
          let made;
          try { made = this.call(tool, a, at); } catch { break; }
          this.takeIds(tool, made, value);
          const m = this.box.messages.get(value.id);
          delete m.raw;
          m.know.delete("raw");
          break;
        }
        if (tool === "create_draft" && value.id && value.messageId) {
          try { this.takeIds(tool, this.createDraft(a, at), value); }
          catch { this.box.drafts.set(value.id, value.messageId); }
          break;
        }
        if (tool === "update_draft" && value.messageId) {
          try { this.takeIds(tool, this.updateDraft(a, at), value); } catch { /* draft unknown to the copy */ }
          break;
        }
        if (tool === "create_label" && value.labelId && this.box.labels) {
          this.box.addLabel({ labelId: value.labelId, labelListVisibility: value.labelListVisibility, labelType: "USER", messageListVisibility: value.messageListVisibility, messagesTotal: 0, messagesUnread: 0, name: value.name, threadsTotal: 0, threadsUnread: 0 });
          break;
        }
        if (tool === "delete_draft") { const id = this.box.drafts.get(a.draftId); this.box.drafts.delete(a.draftId); if (id) this.box.messages.delete(id); break; }
        try { this.call(tool, a, at); } catch { /* the copy cannot apply a past write it cannot see */ }
      }
    }
  }
}
export { BODY_KEYS };
