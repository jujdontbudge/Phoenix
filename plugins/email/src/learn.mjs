// Learns mail from himalaya's JSON output: what the session's own himalaya calls printed and what a
// command-line capture read. Envelopes keep their real ids (UIDs per folder), folder and flags; a
// message whose body was read gets that body. A body never read stays unknown, so reading it falls
// through. Plain-text output is not parsed.
import { addresses, buildMessage, decodeWords, header, rfc2822, splitHead } from "./mime.mjs";
import { snippetOf } from "./mailbox.mjs";

const SYSTEM = { INBOX: "INBOX", "[Gmail]/Drafts": "DRAFT", "[Gmail]/Important": "IMPORTANT", "[Gmail]/Sent Mail": "SENT", "[Gmail]/Spam": "SPAM", "[Gmail]/Starred": "STARRED", "[Gmail]/Trash": "TRASH", "[Gmail]/All Mail": null };
export const VALUED = new Set(["-f", "--folder", "-o", "--output", "-a", "--account", "-c", "--config", "-H", "--header", "--page", "-s", "--page-size", "-w", "--max-width"]);
export const valued = (argv, option) => VALUED.has(option) || (option === "-p" && argv.includes("envelope"));

const CONDITIONS = new Set(["date", "before", "after", "from", "to", "subject", "body", "flag"]);

function command(argv, aliases = {}) {
  const options = {}, words = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
    if (eq) { (options[eq[1]] ??= []).push(eq[2]); continue; }
    if (valued(argv, a)) { (options[a] ??= []).push(argv[++i]); continue; }
    if (a.startsWith("-")) { options[a] = [true]; continue; }
    words.push(a);
  }
  const value = (...names) => names.flatMap(n => options[n] ?? []).at(-1);
  const folder = value("-f", "--folder") ?? "INBOX";
  let sorted = false;
  for (let i = 2; i < words.length && !sorted; i += CONDITIONS.has(words[i]) ? 2 : 1) sorted = words[i] === "order" && words[i + 1] === "by";
  return { words, folder: aliases[folder.toLowerCase()] ?? folder, json: value("-o", "--output") === "json", newestFirst: !sorted };
}

function folderLabel(box, folder) {
  const name = folder.toUpperCase() === "INBOX" ? "INBOX" : folder;
  if (name in SYSTEM) return { known: true, label: SYSTEM[name] };
  const user = (box.labels ?? []).find(l => l.labelType === "USER" && l.name === name);
  return user ? { known: true, label: user.labelId } : { known: false };
}

// Whether a himalaya call is a read, by the plugin's read_only entries: their words lead the command
// and their options are present.
export function reads(argv, entries) {
  const { words } = command(argv);
  return entries.some(entry => {
    const tokens = entry.split(" ").slice(1);
    return tokens.filter(t => !t.startsWith("-")).every((t, i) => words[i] === t) && tokens.filter(t => t.startsWith("-")).every(t => argv.includes(t));
  });
}

// A UID the real service printed. The copy gives its own UIDs to mail it made, such as a replayed send,
// and a later real listing replaces them.
function realUid(box, m, folder, uid) {
  for (const o of box.messages.values()) if (o !== m && o.uids[folder] === uid) { delete o.uids[folder]; o.realUids?.delete(folder); }
  m.uids[folder] = uid;
  (m.realUids ??= new Set()).add(folder);
  const info = box.folderInfo?.[folder];
  box.folderInfo = { ...box.folderInfo, [folder]: { uidvalidity: info?.uidvalidity ?? 1, uidnext: Math.max(info?.uidnext ?? 1, uid + 1) } };
}

// The minutes a listed date can show for a message: its own Date header's, or when it arrived.
const minutes = m => new Set([Number(m.internalDate), m.raw ? Date.parse(header(splitHead(m.raw).headers, "date") ?? "") : NaN].filter(Number.isFinite).map(ms => Math.floor(ms / 60000)));
const heads = m => {
  const headers = m.raw ? splitHead(m.raw).headers : [];
  return { sender: m.fields.sender ?? addresses(header(headers, "from") ?? "")[0]?.email, to: m.fields.toRecipients ?? addresses(header(headers, "to") ?? "").map(a => a.email) };
};
const byUid = (box, folder, uid) => [...box.messages.values()].find(m => m.uids[folder] === uid);
const byRealUid = (box, folder, uid) => [...box.messages.values()].find(m => m.uids[folder] === uid && m.realUids?.has(folder));
const dateMs = text => { const ms = Date.parse(String(text ?? "").replace(" ", "T")); return Number.isFinite(ms) ? ms : undefined; };
const offsetOf = text => { const found = /([+-]\d{2}):?(\d{2})$/.exec(String(text ?? "")); return found ? found[1] + found[2] : undefined; };

// himalaya prints dates to the minute, newest first. Messages listed in the same minute get seconds
// that keep the order himalaya printed them in; a listing that shows more of that minute refines them.
function envelopes(box, folder, list, newestFirst) {
  const place = folderLabel(box, folder);
  if (!place.known || !Array.isArray(list)) return;
  for (const [i, e] of list.entries()) {
    const uid = Number(e?.id);
    if (!Number.isInteger(uid)) continue;
    if (place.label === "SENT" && e.from?.addr && !box.account.email) Object.assign(box.account, { email: e.from.addr, name: box.account.name || (e.from.name ?? "") });
    const flags = new Set(e.flags ?? []);
    const labels = [...(place.label ? [place.label] : []), ...(flags.has("Seen") ? [] : ["UNREAD"]), ...(flags.has("Flagged") ? ["STARRED"] : [])];
    const minute = newestFirst && dateMs(e.date) !== undefined ? list.filter(o => o?.date === e.date).length : 0;
    const later = minute ? list.slice(i + 1).filter(o => o?.date === e.date).length : 0;
    const ms = dateMs(e.date) === undefined ? box.nowMs ?? 0 : dateMs(e.date) + Math.min(later, 59) * 1000;
    // Recorded observations of one message in different folders are joined by their envelope. A record
    // a replayed write made is never joined this way: only a recorded id ties it to anything.
    const alike = [...box.messages.values()].filter(o => {
      if (o.provisional || o.realUids?.has(folder) || o.fields.subject !== e.subject || !minutes(o).has(Math.floor(ms / 60000))) return false;
      const { sender, to } = heads(o);
      return sender === e.from?.addr && (!e.to?.addr || to.includes(e.to.addr));
    });
    let m = byRealUid(box, folder, uid) ?? (alike.length === 1 ? alike[0] : undefined);
    if (!m && alike.length > 1) continue;
    if (m) {
      realUid(box, m, folder, uid);
      if (m.minute !== undefined && minute >= m.minute && Math.floor(Number(m.internalDate) / 60000) === Math.floor(ms / 60000)) Object.assign(m, { internalDate: String(ms), minute });
    } else {
      const id = box.newId(ms);
      m = { id, threadId: id, labelIds: [], internalDate: String(ms), fields: {}, know: new Set(["metadata"]), observedAt: -1, uids: {}, minute };
      box.add(m);
      realUid(box, m, folder, uid);
    }
    const others = m.labelIds.filter(l => !["UNREAD", "STARRED", place.label].includes(l));
    box.relabel(m, [...others, ...labels], m.labelIds.filter(l => !others.includes(l) && !labels.includes(l)));
    m.dateOffset ??= offsetOf(e.date);
    const f = m.fields;
    if (e.subject !== undefined) f.subject ??= e.subject;
    if (e.from?.addr) { f.sender ??= e.from.addr; if (e.from.name) f.addressDisplayNames ??= [{ displayName: e.from.name, emailAddress: e.from.addr }]; }
    if (e.to?.addr) { f.toRecipients ??= [e.to.addr]; if (e.to.name) m.names = { ...m.names, [e.to.addr]: e.to.name }; }
    f.date ??= new Date(Number(m.internalDate)).toISOString().replace(".000Z", "Z");
  }
}

function read(box, folder, uid, text) {
  if (typeof text !== "string") return;
  const split = text.indexOf("\n\n");
  if (split < 0) return;
  const head = text.slice(0, split).split("\n").map(line => { const at = line.indexOf(": "); return [line.slice(0, at).toLowerCase(), line.slice(at + 2)]; });
  const get = name => head.find(([n]) => n === name)?.[1];
  let body = text.slice(split + 2);
  if (/^<#(multi)?part/m.test(body)) return;
  body = body.replace(/\n+$/, "\n");
  const from = addresses(get("from") ?? "")[0];
  const date = get("date");
  const ms = dateMs(date) ?? (date ? Date.parse(date) : undefined);
  const stableId = get("message-id");
  let m = byRealUid(box, folder, uid) ?? (stableId ? [...box.messages.values()].find(o => o.raw && header(splitHead(o.raw).headers, "message-id") === stableId) : undefined);
  if (m && !m.realUids?.has(folder)) realUid(box, m, folder, uid);
  if (!m) {
    if (!folderLabel(box, folder).known) return;
    const id = box.newId(ms ?? box.nowMs ?? 0);
    m = { id, threadId: id, labelIds: [], internalDate: String(ms ?? box.nowMs ?? 0), fields: {}, know: new Set(), observedAt: -1, uids: {} };
    box.add(m);
    realUid(box, m, folder, uid);
    const place = folderLabel(box, folder).label;
    if (place) box.relabel(m, [place], []);
  }
  const inReplyTo = get("in-reply-to"), references = get("references"), messageId = get("message-id") ?? `<${m.id}@mail.gmail.com>`;
  const parent = inReplyTo && [...box.messages.values()].find(o => o !== m && o.raw && box.messageIdOf(o) === inReplyTo);
  if (parent) m.threadId = parent.threadId;
  const to = addresses(get("to") ?? ""), cc = addresses(get("cc") ?? "");
  const f = m.fields;
  if (from) { f.sender = from.email; if (from.name) f.addressDisplayNames = [{ displayName: from.name, emailAddress: from.email }]; }
  if (to.length) f.toRecipients = to.map(a => a.email);
  if (cc.length) f.ccRecipients = cc.map(a => a.email);
  if (get("subject") !== undefined) f.subject = decodeWords(get("subject"));
  f.plaintextBody = body;
  f.snippet = snippetOf(body);
  m.raw = buildMessage({ from: from ?? { name: "", email: "" }, to, cc, subject: f.subject ?? "", text: body, html: "", date: date ?? rfc2822(new Date(Number(m.internalDate)), "UTC", m.dateOffset), messageId, inReplyTo, references, boundary: `000000000000${m.id}` });
  m.rawWritten = true;
  for (const k of ["metadata", "minimal", "body"]) m.know.add(k);
}

// A recorded `envelope list -o json` run against the copy: when the copy listed the same messages,
// they take the ids the real list printed, so later calls by those ids reach them.
export function takeUids(box, argv, ours, theirs, aliases = {}) {
  const { words, folder, json } = command(argv, aliases);
  if (!json || words[0] !== "envelope" || words[1] !== "list") return;
  let copy, real;
  try { copy = JSON.parse(ours); real = JSON.parse(theirs); } catch { return; }
  if (!Array.isArray(copy) || !Array.isArray(real) || copy.length !== real.length) return;
  const identity = e => JSON.stringify([e?.subject, e?.from?.addr, e?.from?.name, e?.to?.addr, e?.date, e?.has_attachment]);
  if (new Set(copy.map(identity)).size !== copy.length) return;
  const pairs = copy.map((e, i) => [byUid(box, folder, Number(e?.id)), Number(real[i]?.id), identity(e) === identity(real[i])]);
  if (pairs.some(([m, uid, same]) => !m || !Number.isInteger(uid) || !same)) return;
  const moving = new Set(pairs.map(([m]) => m));
  if (pairs.some(([, uid]) => { const holder = byUid(box, folder, uid); return holder && !moving.has(holder); })) return;
  for (const [m, uid] of pairs) realUid(box, m, folder, uid);
}

// The folder a list shows in full: an envelope list as JSON with no search, on its first page, shorter than a page.
export function completeList(argv, stdout, aliases = {}) {
  const { words, folder, json } = command(argv, aliases);
  if (!json || words[0] !== "envelope" || words[1] !== "list" || words.length > 2) return;
  const option = names => { for (let i = argv.length - 1; i > 0; i--) { if (names.includes(argv[i])) return argv[i + 1]; const eq = names.map(n => argv[i].startsWith(n + "=") && argv[i].slice(n.length + 1)).find(Boolean); if (eq) return eq; } };
  if (Number(option(["--page", "-p"]) ?? 1) !== 1) return;
  let list;
  try { list = JSON.parse(stdout); } catch { return; }
  return Array.isArray(list) && list.length < Number(option(["--page-size", "-s"]) ?? 10) ? folder : undefined;
}

const inFolder = (m, label) => (label === "TRASH" || label === "SPAM" || !(m.labelIds.includes("TRASH") || m.labelIds.includes("SPAM"))) && (label === null || m.labelIds.includes(label));
const NOT_FOLDERS = new Set(["UNREAD"]);

// A record a replayed write made is the same as another record only when a recorded id says so: a
// Gmail id, a Message-ID the session read, or a UID in a folder's list. In a folder a later complete
// list shows, it is one of the listed messages, so it leaves the copy, and the other folders it was in
// become unsettled. When such a record and another can't be told apart by id, and their subject,
// sender or recipients don't prove them different, they may be one message: both are marked, and the
// copy answers nothing that would show either.
export function settle(box, made, complete) {
  const unsettled = new Set();
  for (const [folder, at] of complete) {
    const { known, label } = folderLabel(box, folder);
    if (!known) continue;
    for (const m of [...box.messages.values()]) {
      if (!(made.get(m.id) < at) || m.realUids?.has(folder) || !inFolder(m, label)) continue;
      for (const l of m.labelIds) if (l !== label && !NOT_FOLDERS.has(l) && !l.startsWith("CATEGORY_")) unsettled.add(l);
      box.messages.delete(m.id);
      if (box.threadCounts.has(m.id) && !box.thread(m.id).length) box.threadCounts.delete(m.id);
    }
  }
  box.unsettled = unsettled;
  const records = [...box.messages.values()];
  const apart = (a, b) => {
    if (a.provisional === b.provisional) return true;
    if ([...(a.realUids ?? [])].some(folder => b.realUids?.has(folder))) return true;
    const ids = [a, b].map(m => m.raw ? header(splitHead(m.raw).headers, "message-id") : undefined);
    if (ids[0] && ids[1]) return ids[0] !== ids[1];
    const differ = key => a.fields[key] !== undefined && b.fields[key] !== undefined && a.fields[key] !== b.fields[key];
    if (differ("subject") || differ("sender")) return true;
    const to = [a, b].map(m => m.fields.toRecipients?.map(x => x.toLowerCase()));
    return !!(to[0]?.length && to[1]?.length && !to[0].some(x => to[1].includes(x)));
  };
  for (const [i, a] of records.entries()) for (const b of records.slice(i + 1)) if (!apart(a, b)) a.ambiguous = b.ambiguous = true;
}

export function learnHimalaya(box, observations, aliases = {}) {
  for (const { argv, stdout } of observations) {
    const { words, folder, json, newestFirst } = command(argv, aliases);
    if (!json) continue;
    let value;
    try { value = JSON.parse(stdout); } catch { continue; }
    if (words[0] === "envelope" && words[1] === "list") envelopes(box, folder, value, newestFirst);
    if (words[0] === "message" && words[1] === "read" && words.length === 3 && /^\d+$/.test(words[2])) read(box, folder, Number(words[2]), value);
  }
}
