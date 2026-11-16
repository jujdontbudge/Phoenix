// An IMAP4rev1 server over the mailbox, laid out the way Gmail lays labels out as folders, and a
// small SMTP server that files sent mail the way Gmail does. Real IMAP clients such as himalaya
// talk to these instead of imap.gmail.com and smtp.gmail.com, so their own formatting stays real.
import { createServer } from "node:net";
import { addresses, decodeWords, header, rfc2822, splitHead } from "./mime.mjs";

const SYSTEM = [
  ["INBOX", "INBOX", []],
  ["[Gmail]/All Mail", null, ["\\All"]],
  ["[Gmail]/Drafts", "DRAFT", ["\\Drafts"]],
  ["[Gmail]/Important", "IMPORTANT", ["\\Important"]],
  ["[Gmail]/Sent Mail", "SENT", ["\\Sent"]],
  ["[Gmail]/Spam", "SPAM", ["\\Junk"]],
  ["[Gmail]/Starred", "STARRED", ["\\Flagged"]],
  ["[Gmail]/Trash", "TRASH", ["\\Trash"]],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class Folders {
  constructor(box) {
    this.box = box;
    this.state = new Map();
    this.extra = new Map();
  }

  list() {
    const user = (this.box.labels ?? []).filter(l => l.labelType === "USER").map(l => [l.name, l.labelId, []]);
    return [...SYSTEM, ...user];
  }

  find(name) {
    const wanted = name.toUpperCase() === "INBOX" ? "INBOX" : name;
    return this.list().find(([n]) => n === wanted);
  }

  inFolder(m, entry) {
    const [, label] = entry;
    if (label !== "TRASH" && label !== "SPAM" && (m.labelIds.includes("TRASH") || m.labelIds.includes("SPAM"))) return false;
    return label === null || m.labelIds.includes(label);
  }

  // Each folder keeps its own UIDs; a message keeps its UID while it stays in the folder.
  messages(name) {
    const entry = this.find(name);
    if (!entry) return undefined;
    const state = this.status(name);
    const members = [...this.box.messages.values()].filter(m => this.inFolder(m, entry)).sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0) || (a.id < b.id ? -1 : 1));
    state.uidnext = Math.max(state.uidnext, ...members.filter(m => m.uids[name] !== undefined).map(m => m.uids[name] + 1));
    for (const m of members) if (m.uids[name] === undefined) m.uids[name] = state.uidnext++;
    return members.sort((a, b) => a.uids[name] - b.uids[name]);
  }

  status(name) {
    if (!this.state.has(name)) {
      const known = [...this.box.messages.values()].map(m => m.uids[name]).filter(u => u !== undefined);
      this.state.set(name, { uidvalidity: this.box.folderInfo?.[name]?.uidvalidity ?? 1, uidnext: Math.max(this.box.folderInfo?.[name]?.uidnext ?? 1, ...known.map(u => u + 1)) });
    }
    const state = this.state.get(name);
    state.uidnext = Math.max(state.uidnext, this.box.folderInfo?.[name]?.uidnext ?? 1);
    return state;
  }

  flags(m, name) {
    const out = [...(this.extra.get(m.id) ?? [])];
    if (!m.labelIds.includes("UNREAD")) out.push("\\Seen");
    if (m.labelIds.includes("STARRED")) out.push("\\Flagged");
    if (m.labelIds.includes("DRAFT")) out.push("\\Draft");
    if (this.deleted(m, name)) out.push("\\Deleted");
    return out;
  }

  deleted(m, name) { return this.extra.get(`${name}\u0000${m.id}`)?.has("\\Deleted") ?? false; }

  setFlags(m, name, flags, mode) {
    const current = new Set(this.flags(m, name));
    const next = mode === "+" ? new Set([...current, ...flags]) : mode === "-" ? new Set([...current].filter(f => !flags.includes(f))) : new Set(flags);
    const add = [], remove = [];
    const map = { "\\Seen": ["UNREAD", true], "\\Flagged": ["STARRED", false] };
    for (const [flag, [label, inverse]] of Object.entries(map)) {
      const want = next.has(flag), had = current.has(flag);
      if (want === had) continue;
      if (want !== inverse) add.push(label); else remove.push(label);
    }
    this.box.relabel(m, add, remove);
    const extra = new Set([...next].filter(f => !["\\Seen", "\\Flagged", "\\Draft", "\\Deleted"].includes(f)));
    this.extra.set(m.id, extra);
    const del = `${name}\u0000${m.id}`;
    if (next.has("\\Deleted")) this.extra.set(del, new Set(["\\Deleted"])); else this.extra.delete(del);
  }

  // Gmail: adding a message to a folder adds its label; Trash and Spam hide it from the rest.
  copy(m, target) {
    const entry = this.find(target);
    if (!entry) return false;
    const [, label] = entry;
    if (label === "TRASH" || label === "SPAM") this.box.relabel(m, [label], ["INBOX"]);
    else if (label) this.box.relabel(m, [label], label === "INBOX" ? ["TRASH", "SPAM"] : []);
    return true;
  }

  // Gmail: expunging from a label folder removes the label; from Trash or Spam deletes for ever;
  // from All Mail moves to Trash.
  expunge(m, name) {
    const [, label] = this.find(name);
    this.extra.delete(`${name}\u0000${m.id}`);
    if (label === "TRASH" || label === "SPAM") this.box.remove(m);
    else if (label === null) this.box.relabel(m, ["TRASH"], ["INBOX"]);
    else if (label === "DRAFT") this.box.remove(m);
    else this.box.relabel(m, [], [label]);
  }
}

// --- message structure for FETCH ---
const q = s => s === undefined || s === null ? "NIL" : `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
const lit = buffer => `{${buffer.length}}\r\n${buffer.toString("latin1")}`;
const str = s => s === undefined || s === null ? "NIL" : /[\r\n"\\]/.test(s) || /[^\x20-\x7e]/.test(s) ? lit(Buffer.from(s, "utf8")) : q(s);
const addrList = value => {
  if (!value) return "NIL";
  const list = addresses(value);
  if (!list.length) return "NIL";
  return "(" + list.map(a => { const [mailbox, host] = a.email.split("@"); return `(${a.name ? str(a.name) : "NIL"} NIL ${q(mailbox)} ${q(host)})`; }).join("") + ")";
};
const rawHeader = (headers, name) => headers.find(([n]) => n.toLowerCase() === name)?.[1];

export function envelope(raw, arrived) {
  const { headers } = splitHead(raw);
  const from = rawHeader(headers, "from");
  return `(${str(rawHeader(headers, "date") ?? arrived)} ${str(rawHeader(headers, "subject"))} ${addrList(from)} ${addrList(rawHeader(headers, "sender") ?? from)} ${addrList(rawHeader(headers, "reply-to") ?? from)} ${addrList(rawHeader(headers, "to"))} ${addrList(rawHeader(headers, "cc"))} ${addrList(rawHeader(headers, "bcc"))} ${str(rawHeader(headers, "in-reply-to"))} ${str(rawHeader(headers, "message-id"))})`;
}

function contentType(headers) {
  const value = rawHeader(headers, "content-type") ?? "text/plain; charset=us-ascii";
  const [type, ...rest] = value.split(";");
  const [major, minor] = type.trim().toLowerCase().split("/");
  const params = [];
  for (const part of rest) { const at = part.indexOf("="); if (at > 0) params.push([part.slice(0, at).trim(), part.slice(at + 1).trim().replace(/^"(.*)"$/, "$1")]); }
  return { major: major || "text", minor: minor || "plain", params };
}

// A MIME tree with the byte ranges each part covers, for BODYSTRUCTURE and BODY[n].
export function tree(raw) {
  const { headers, head, body } = splitHead(raw);
  const type = contentType(headers);
  const node = { raw, headers, head, body, type, children: [] };
  const boundary = type.params.find(([k]) => k.toLowerCase() === "boundary")?.[1];
  if (type.major === "multipart" && boundary) {
    const text = body.toString("latin1");
    const pieces = text.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      node.children.push(tree(Buffer.from(piece.replace(/^[ \t]*\r?\n/, ""), "latin1")));
    }
  } else if (type.major === "message" && type.minor === "rfc822") node.children.push(tree(body));
  return node;
}

export function bodystructure(node, extended = true) {
  const params = list => list.length ? "(" + list.map(([k, v]) => `${q(k)} ${q(v)}`).join(" ") + ")" : "NIL";
  if (node.type.major === "multipart" && node.children.length) return "(" + node.children.map(c => bodystructure(c, extended)).join("") + ` ${q(node.type.minor)}${extended ? ` ${params(node.type.params)} NIL NIL NIL` : ""})`;
  const encoding = rawHeader(node.headers, "content-transfer-encoding") ?? "7bit";
  const lines = node.body.toString("latin1").split("\n").length - (node.body.toString("latin1").endsWith("\n") ? 1 : 0);
  const disposition = rawHeader(node.headers, "content-disposition");
  let dispo = "NIL";
  if (disposition) { const [kind, ...rest] = disposition.split(";"); const ps = rest.map(p => { const at = p.indexOf("="); return [p.slice(0, at).trim(), p.slice(at + 1).trim().replace(/^"(.*)"$/, "$1")]; }).filter(([k]) => k); dispo = `(${q(kind.trim())} ${params(ps)})`; }
  const base = `${q(node.type.major)} ${q(node.type.minor)} ${params(node.type.params)} ${str(rawHeader(node.headers, "content-id"))} ${str(rawHeader(node.headers, "content-description"))} ${q(encoding)} ${node.body.length}`;
  const ext = extended ? ` NIL ${dispo} NIL NIL` : "";
  if (node.type.major === "text") return `(${base} ${lines}${ext})`;
  if (node.type.major === "message" && node.type.minor === "rfc822" && node.children[0]) return `(${base} ${envelope(node.body)} ${bodystructure(node.children[0], extended)} ${lines}${ext})`;
  return `(${base}${ext})`;
}

function section(raw, spec) {
  const m = /^((?:\d+\.)*\d+)?\.?(HEADER\.FIELDS\.NOT|HEADER\.FIELDS|HEADER|TEXT|MIME)?\s*(?:\(([^)]*)\))?$/i.exec(spec.trim());
  if (!m) return Buffer.alloc(0);
  let node = tree(raw);
  const path = m[1] ? m[1].split(".").map(Number) : [];
  for (const n of path) {
    if (node.type.major === "message" && node.children[0]) node = node.children[0];
    node = node.children.length ? node.children[n - 1] : n === 1 ? node : undefined;
    if (!node) return Buffer.alloc(0);
  }
  const kind = (m[2] ?? "").toUpperCase();
  const headerBytes = n => Buffer.concat([n.head, Buffer.from("\r\n\r\n")]);
  if (!kind) return path.length ? node.body : raw;
  if (kind === "TEXT") return node.body;
  if (kind === "HEADER" || kind === "MIME") return headerBytes(node);
  const names = (m[3] ?? "").split(/\s+/).filter(Boolean).map(s => s.replace(/"/g, "").toLowerCase());
  const keep = [];
  const lines = node.head.toString("latin1").split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) { if (current) current.push(line); continue; }
    const name = line.slice(0, line.indexOf(":")).toLowerCase();
    const wanted = kind === "HEADER.FIELDS" ? names.includes(name) : !names.includes(name);
    current = wanted ? [line] : null;
    if (current) keep.push(current);
  }
  return Buffer.from(keep.map(l => l.join("\r\n")).join("\r\n") + "\r\n\r\n", "latin1");
}

const imapDate = ms => {
  const d = new Date(Number(ms));
  const two = n => String(n).padStart(2, "0");
  return `"${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000"`;
};

// --- the command reader: tokens, quoted strings and literals ---
class Reader {
  constructor(socket, onCommand) {
    this.buffer = Buffer.alloc(0);
    this.socket = socket;
    this.onCommand = onCommand;
    this.parts = [];
    this.need = 0;
    socket.on("data", chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); });
  }
  pump() {
    for (;;) {
      if (this.need) {
        if (this.buffer.length < this.need) return;
        this.parts.push({ literal: this.buffer.subarray(0, this.need) });
        this.buffer = this.buffer.subarray(this.need);
        this.need = 0;
        continue;
      }
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = this.buffer.subarray(0, end).toString("latin1");
      this.buffer = this.buffer.subarray(end + 2);
      const literal = /\{(\d+)(\+?)\}$/.exec(line);
      if (literal) {
        this.parts.push({ text: line.slice(0, literal.index) });
        this.need = Number(literal[1]);
        if (!literal[2]) this.socket.write("+ Ready for literal data\r\n");
        if (this.need === 0) { this.parts.push({ literal: Buffer.alloc(0) }); }
        continue;
      }
      this.parts.push({ text: line });
      const parts = this.parts;
      this.parts = [];
      this.onCommand(parts);
    }
  }
}

function tokens(parts) {
  const out = [];
  const stack = [out];
  for (const part of parts) {
    if (part.literal) { stack.at(-1).push(part.literal.toString("utf8")); continue; }
    const re = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|(BODY(?:\.PEEK)?\[[^\]]*\](?:<[\d.]+>)?|BINARY(?:\.PEEK)?\[[^\]]*\](?:<[\d.]+>)?|[^\s()"]+))/gy;
    let m;
    const text = part.text;
    re.lastIndex = 0;
    while (re.lastIndex < text.length && (m = re.exec(text))) {
      if (m[1]) { const list = []; stack.at(-1).push(list); stack.push(list); }
      else if (m[2]) { if (stack.length > 1) stack.pop(); }
      else if (m[3] !== undefined) stack.at(-1).push(m[3].replace(/\\(.)/g, "$1"));
      else if (m[4] !== undefined) stack.at(-1).push(m[4]);
    }
  }
  return out;
}

function sequence(set, members, uid, folderName) {
  const max = uid ? (members.length ? members.at(-1).uids[folderName] : 0) : members.length;
  const picked = new Set();
  for (const range of String(set).split(",")) {
    const [a, b] = range.split(":");
    const lo = a === "*" ? max : Number(a), hi = b === undefined ? lo : b === "*" ? max : Number(b);
    const [from, to] = lo <= hi ? [lo, hi] : [hi, lo];
    members.forEach((m, i) => { const n = uid ? m.uids[folderName] : i + 1; if (n >= from && n <= to) picked.add(m); });
    if (uid && b === "*" && members.length && from > max) picked.add(members.at(-1));
  }
  return members.filter(m => picked.has(m));
}

export function startImap(box, { log } = {}) {
  const folders = new Folders(box);
  // A folder whose records the copy can't tell apart from each other answers nothing.
  const unsure = name => {
    const entry = folders.find(name);
    if (!entry || !(box.unsettled?.has(entry[1]) || folders.messages(name).some(m => m.ambiguous))) return false;
    box.missed = `the copy can't tell which of its records in ${entry[0]} are the same message`;
    return true;
  };
  const server = createServer(socket => {
    let selected = null, readOnly = false;
    const send = line => { log?.("S: " + line.slice(0, 300)); socket.write(line + "\r\n"); };
    send("* OK Gimap ready for requests from 127.0.0.1 phoenix-copy");
    const exists = () => folders.messages(selected).length;
    let lastExists = 0;
    const handle = parts => {
      const t = tokens(parts);
      log?.("C: " + JSON.stringify(t).slice(0, 300));
      const tag = t[0];
      let cmd = String(t[1] ?? "").toUpperCase();
      let args = t.slice(2);
      let uid = false;
      if (cmd === "UID") { uid = true; cmd = String(args[0]).toUpperCase(); args = args.slice(1); }
      const ok = (text = "Success") => send(`${tag} OK ${text}`);
      const no = text => send(`${tag} NO ${text}`);
      const bad = text => send(`${tag} BAD ${text}`);
      const caps = "IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS COMPRESS=DEFLATE ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT=35651584";
      try {
        switch (cmd) {
          case "CAPABILITY": send(`* CAPABILITY ${caps} AUTH=PLAIN`); return ok("Thats all she wrote!");
          case "NOOP": case "CHECK": return ok();
          case "ID": send('* ID ("name" "GImap" "vendor" "Google, Inc." "support-url" "https://support.google.com/mail")'); return ok();
          case "ENABLE": send("* ENABLED"); return ok();
          case "LOGIN": send(`* CAPABILITY ${caps}`); return ok(`${args[0]} authenticated (Success)`);
          case "AUTHENTICATE": {
            if (args.length > 1) { send(`* CAPABILITY ${caps}`); return ok("authenticated (Success)"); }
            socket.write("+ \r\n");
            pendingAuth = () => { send(`* CAPABILITY ${caps}`); ok("authenticated (Success)"); };
            return;
          }
          case "LOGOUT": send("* BYE LOGOUT Requested"); ok("73 good day (Success)"); socket.end(); return;
          case "NAMESPACE": send('* NAMESPACE (("" "/")) NIL NIL'); return ok();
          case "LIST": case "LSUB": case "XLIST": {
            const pattern = String(args.find((a, i) => i === 1 && !Array.isArray(a)) ?? args[1] ?? "*");
            if (pattern === "") { send(`* ${cmd} (\\Noselect) "/" ""`); return ok(); }
            const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, "[^/]*") + "$", "i");
            const rows = [["[Gmail]", null, ["\\HasChildren", "\\Noselect"]], ...folders.list().map(([n, , f]) => [n, null, [n.startsWith("[Gmail]/") || n === "INBOX" ? "\\HasNoChildren" : "\\HasNoChildren", ...f]])];
            for (const [name, , flags] of rows) if (re.test(name)) send(`* ${cmd} (${flags.join(" ")}) "/" ${q(name)}`);
            return ok();
          }
          case "STATUS": {
            const name = String(args[0]);
            if (unsure(name)) return no(`[UNAVAILABLE] ${box.missed}`);
            const members = folders.messages(name);
            if (!members) return no("[NONEXISTENT] Unknown Mailbox");
            const st = folders.status(name);
            const want = (args[1] ?? []).map(x => String(x).toUpperCase());
            const vals = { MESSAGES: members.length, RECENT: 0, UIDNEXT: st.uidnext, UIDVALIDITY: st.uidvalidity, UNSEEN: members.filter(m => m.labelIds.includes("UNREAD")).length, HIGHESTMODSEQ: box.history };
            send(`* STATUS ${q(name)} (${want.map(k => `${k} ${vals[k] ?? 0}`).join(" ")})`);
            return ok();
          }
          case "SELECT": case "EXAMINE": {
            const name = String(args[0]);
            if (unsure(name)) { selected = null; return no(`[UNAVAILABLE] ${box.missed}`); }
            const members = folders.messages(name);
            if (!members) { selected = null; return no("[NONEXISTENT] Unknown Mailbox"); }
            selected = folders.find(name)[0]; readOnly = cmd === "EXAMINE";
            const st = folders.status(selected);
            send("* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen $NotPhishing $Phishing)");
            send("* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen $NotPhishing $Phishing \\*)] Flags permitted.");
            send(`* OK [UIDVALIDITY ${st.uidvalidity}] UIDs valid.`);
            send(`* ${members.length} EXISTS`); send("* 0 RECENT");
            send(`* OK [UIDNEXT ${st.uidnext}] Predicted next UID.`);
            send(`* OK [HIGHESTMODSEQ ${box.history}] Highest`);
            lastExists = members.length;
            return ok(`[${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${selected} selected. (Success)`);
          }
          case "CLOSE": case "UNSELECT": {
            if (cmd === "CLOSE" && selected && !readOnly) for (const m of folders.messages(selected)) if (folders.deleted(m, selected)) folders.expunge(m, selected);
            selected = null; return ok("Returned to authenticated state. (Success)");
          }
          case "CREATE": { if (!box.labels) { box.missed = "the copy never saw the label list"; return no(`[UNAVAILABLE] ${box.missed}`); } box.createLabel(String(args[0])); return ok("Success"); }
          case "DELETE": { const label = box.labels?.find(l => l.labelType === "USER" && l.name === String(args[0])); if (!label) return no("[NONEXISTENT] Folder doesn't exist."); box.deleteLabel(label.labelId); return ok("Success"); }
          case "SUBSCRIBE": case "UNSUBSCRIBE": return ok();
          case "APPEND": {
            const name = String(args[0]);
            const entry = folders.find(name);
            if (!entry) return no("[TRYCREATE] Folder doesn't exist.");
            const raw = Buffer.from(args.at(-1), "utf8");
            const flags = Array.isArray(args[1]) ? args[1].map(String) : [];
            folders.messages(name);
            const held = new Set(box.messages.keys());
            const m = box.receive(raw, { labels: entry[1] ? [entry[1]] : [], seen: flags.includes("\\Seen"), flagged: flags.includes("\\Flagged") });
            if (held.has(m.id) && m.uids[name] !== undefined) { delete m.uids[name]; m.realUids?.delete(name); }
            const members = folders.messages(name);
            return ok(`[APPENDUID ${folders.status(name).uidvalidity} ${m.uids[name] ?? members.at(-1)?.uids[name]}] (Success)`);
          }
          case "IDLE": send("+ idling"); idling = true; return;
        }
        if (!selected) return bad("Command not valid in this state");
        const members = folders.messages(selected);
        switch (cmd) {
          case "SEARCH": {
            const items = args[0] && String(args[0]).toUpperCase() === "RETURN" ? args.slice(2) : args;
            const crit = items[0] && String(items[0]).toUpperCase() === "CHARSET" ? items.slice(2) : items;
            const hits = members.filter((m, i) => matches(crit, m, i + 1));
            send(`* SEARCH${hits.length ? " " : ""}${hits.map(m => uid ? m.uids[selected] : members.indexOf(m) + 1).join(" ")}`);
            return ok("SEARCH completed (Success)");
          }
          case "FETCH": {
            const picked = sequence(args[0], members, uid, selected);
            let items = Array.isArray(args[1]) ? args[1].map(String) : [String(args[1])];
            const macro = { ALL: ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"], FAST: ["FLAGS", "INTERNALDATE", "RFC822.SIZE"], FULL: ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"] }[items[0]?.toUpperCase()];
            if (macro) items = macro;
            if (uid && !items.some(i => i.toUpperCase() === "UID")) items = ["UID", ...items];
            const content = items.some(i => /^(RFC822|RFC822\.TEXT)$/i.test(i) || /^(BODY|BINARY)(\.PEEK)?\[(?!HEADER)/i.test(i));
            const unknown = content && picked.find(m => (!m.raw || m.rawWritten) && !m.know.has("body"));
            if (unknown) { box.missed = `the copy does not hold the content of message ${unknown.id}`; return no(`[UNAVAILABLE] ${box.missed}`); }
            for (const m of picked) {
              const raw = box.rawOf(m);
              const out = [];
              let seen = false;
              for (const item of items) {
                const up = item.toUpperCase();
                if (up === "UID") out.push(`UID ${m.uids[selected]}`);
                else if (up === "FLAGS") out.push(`FLAGS (${folders.flags(m, selected).join(" ")})`);
                else if (up === "INTERNALDATE") out.push(`INTERNALDATE ${imapDate(m.internalDate)}`);
                else if (up === "RFC822.SIZE") out.push(`RFC822.SIZE ${raw.length}`);
                else if (up === "ENVELOPE") out.push(`ENVELOPE ${envelope(raw, rfc2822(new Date(Number(m.internalDate)), "America/Los_Angeles"))}`);
                else if (up === "BODYSTRUCTURE" || up === "BODY") out.push(`${up} ${bodystructure(tree(raw), up === "BODYSTRUCTURE")}`);
                else if (up === "X-GM-MSGID") out.push(`X-GM-MSGID ${BigInt("0x" + m.id)}`);
                else if (up === "X-GM-THRID") out.push(`X-GM-THRID ${BigInt("0x" + m.threadId)}`);
                else if (up === "X-GM-LABELS") out.push(`X-GM-LABELS (${m.labelIds.filter(l => !["UNREAD", "STARRED", "SENT", "DRAFT"].includes(l) || l === "SENT").map(l => l === "SENT" ? '"\\\\Sent"' : l === "INBOX" ? '"\\\\Inbox"' : l === "IMPORTANT" ? '"\\\\Important"' : q(l)).join(" ")})`);
                else if (up === "MODSEQ") out.push(`MODSEQ (${m.historyId ?? 1})`);
                else if (/^(RFC822(\.HEADER|\.TEXT)?)$/.test(up)) { const bytes = up === "RFC822" ? raw : section(raw, up === "RFC822.HEADER" ? "HEADER" : "TEXT"); out.push(`${up} ${lit(bytes)}`); if (up !== "RFC822.HEADER") seen = true; }
                else {
                  const b = /^(BODY|BINARY)(\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/i.exec(item);
                  if (!b) continue;
                  let bytes = section(raw, b[3]);
                  if (b[4] !== undefined) bytes = bytes.subarray(Number(b[4]), b[5] !== undefined ? Number(b[4]) + Number(b[5]) : undefined);
                  out.push(`${b[1].toUpperCase()}[${b[3]}]${b[4] !== undefined ? `<${b[4]}>` : ""} ${lit(bytes)}`);
                  if (!b[2]) seen = true;
                }
              }
              if (seen && !readOnly && m.labelIds.includes("UNREAD")) { box.relabel(m, [], ["UNREAD"]); if (!items.some(i => i.toUpperCase() === "FLAGS")) out.push(`FLAGS (${folders.flags(m, selected).join(" ")})`); }
              send(`* ${members.indexOf(m) + 1} FETCH (${out.join(" ")})`);
            }
            return ok("Success");
          }
          case "STORE": {
            if (readOnly) return no("Mailbox is read-only");
            const picked = sequence(args[0], members, uid, selected);
            const what = String(args[1]).toUpperCase();
            const mode = what.startsWith("+") ? "+" : what.startsWith("-") ? "-" : "=";
            const flags = (Array.isArray(args[2]) ? args[2] : args.slice(2)).map(String);
            for (const m of picked) {
              folders.setFlags(m, selected, flags, mode);
              if (!what.includes(".SILENT")) send(`* ${members.indexOf(m) + 1} FETCH (${uid ? `UID ${m.uids[selected]} ` : ""}FLAGS (${folders.flags(m, selected).join(" ")}))`);
            }
            return ok("Success");
          }
          case "COPY": case "MOVE": {
            const picked = sequence(args[0], members, uid, selected);
            const target = String(args[1]);
            if (!folders.find(target)) return no("[TRYCREATE] No folder " + target + " (Failure)");
            const sourceUids = picked.map(m => m.uids[selected]);
            for (const m of picked) {
              folders.copy(m, target);
              if (cmd === "MOVE") { const [, label] = folders.find(selected); if (label && label !== folders.find(target)[1] && box.messages.has(m.id)) box.relabel(m, [], [label]); }
            }
            const targetUids = picked.map(m => folders.messages(target).find(x => x.id === m.id)?.uids[target]).filter(Boolean);
            const code = `[COPYUID ${folders.status(target).uidvalidity} ${sourceUids.join(",")} ${targetUids.join(",")}]`;
            if (cmd === "MOVE") { send(`* OK ${code}`); for (const m of [...picked].reverse()) send(`* ${members.indexOf(m) + 1} EXPUNGE`); lastExists = folders.messages(selected).length; return ok("(Success)"); }
            return ok(`${code} (Success)`);
          }
          case "EXPUNGE": {
            if (readOnly) return no("Mailbox is read-only");
            const only = uid ? new Set(sequence(args[0], members, true, selected)) : null;
            const gone = members.map((m, i) => [m, i + 1]).filter(([m]) => folders.deleted(m, selected) && (!only || only.has(m)));
            for (const [m] of gone) folders.expunge(m, selected);
            for (const [, n] of gone.reverse()) send(`* ${n} EXPUNGE`);
            lastExists = folders.messages(selected).length;
            return ok("Success");
          }
          default: return bad(`Unknown command ${cmd}`);
        }
      } catch (error) {
        log?.("E: " + (error?.stack ?? error));
        return bad(String(error?.message ?? error));
      } finally {
        if (selected && cmd !== "SELECT" && cmd !== "EXAMINE" && !idling) {
          const now = folders.messages(selected)?.length ?? 0;
          if (now > lastExists) { lastExists = now; }
        }
      }
    };
    let pendingAuth = null, idling = false;
    new Reader(socket, parts => {
      if (pendingAuth) { const done = pendingAuth; pendingAuth = null; return done(); }
      if (idling && parts[0]?.text?.toUpperCase() === "DONE") { idling = false; return; }
      handle(parts);
    });
    socket.on("error", () => {});
    void exists;
  });

  function matches(crit, m, seq) {
    const items = [...crit];
    const next = () => items.shift();
    const one = () => {
      const t = next();
      if (Array.isArray(t)) { const sub = t; const all = []; const save = items.splice(0); items.push(...sub); while (items.length) all.push(one()); items.push(...save); return all.every(Boolean); }
      const k = String(t).toUpperCase();
      const raw = () => box.rawOf(m);
      const head = name => decodeWords(header(splitHead(raw()).headers, name) ?? "").toLowerCase();
      const date = s => { const [d, mon, y] = String(s).split("-"); return Date.UTC(Number(y), MONTHS.indexOf(mon), Number(d)); };
      const day = ms => { const d = new Date(Number(ms)); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
      const sent = () => { const v = Date.parse(header(splitHead(raw()).headers, "date") ?? ""); return day(Number.isNaN(v) ? Number(m.internalDate) : v); };
      switch (k) {
        case "ALL": return true;
        case "SEEN": return !m.labelIds.includes("UNREAD");
        case "UNSEEN": return m.labelIds.includes("UNREAD");
        case "FLAGGED": return m.labelIds.includes("STARRED");
        case "UNFLAGGED": return !m.labelIds.includes("STARRED");
        case "DRAFT": return m.labelIds.includes("DRAFT");
        case "UNDRAFT": return !m.labelIds.includes("DRAFT");
        case "DELETED": return folders.deleted(m, folders.list()[0][0]);
        case "UNDELETED": return true;
        case "ANSWERED": return folders.flags(m, "").includes("\\Answered");
        case "UNANSWERED": return !folders.flags(m, "").includes("\\Answered");
        case "NEW": case "RECENT": return false;
        case "OLD": return true;
        case "KEYWORD": { const f = String(next()); return folders.flags(m, "").includes(f); }
        case "UNKEYWORD": { const f = String(next()); return !folders.flags(m, "").includes(f); }
        case "SUBJECT": case "FROM": case "TO": case "CC": case "BCC": { const v = String(next()).toLowerCase(); return head(k.toLowerCase()).includes(v); }
        case "HEADER": { const name = String(next()); const v = String(next()).toLowerCase(); return head(name).includes(v); }
        case "BODY": { const v = String(next()).toLowerCase(); return (m.fields.plaintextBody ?? m.fields.htmlBody ?? "").toLowerCase().includes(v); }
        case "TEXT": { const v = String(next()).toLowerCase(); return raw().toString("utf8").toLowerCase().includes(v) || (m.fields.plaintextBody ?? "").toLowerCase().includes(v); }
        case "SINCE": return day(m.internalDate) >= date(next());
        case "BEFORE": return day(m.internalDate) < date(next());
        case "ON": return day(m.internalDate) === date(next());
        case "SENTSINCE": return sent() >= date(next());
        case "SENTBEFORE": return sent() < date(next());
        case "SENTON": return sent() === date(next());
        case "LARGER": return raw().length > Number(next());
        case "SMALLER": return raw().length < Number(next());
        case "UID": { const set = next(); const ms = folders.messages(folders.list()[0][0]); return sequence(set, [m], true, Object.keys(m.uids).find(f => true) ?? "").length > 0 || !!ms; }
        case "NOT": return !one();
        case "OR": { const a = one(), b = one(); return a || b; }
        case "X-GM-RAW": { next(); return true; }
        case "MODSEQ": { next(); return true; }
        default: if (/^[\d*:,]+$/.test(k)) return sequence(k, [m], false, "").length > 0 || true; return true;
      }
    };
    let result = true;
    while (items.length) result = one() && result;
    return result;
  }

  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, folders, close: () => new Promise(r => server.close(() => r())) })));
}

// SMTP: Gmail files a sent message under Sent Mail, and under the inbox when you sent it to yourself.
export function startSmtp(box, { log } = {}) {
  const server = createServer(socket => {
    const send = line => { log?.("S: " + line); socket.write(line + "\r\n"); };
    send("220 smtp.gmail.com ESMTP phoenix-copy - gsmtp");
    let buffer = "", data = null, to = [], authSteps = 0;
    socket.on("data", chunk => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (data !== null) {
          const text = data + buffer;
          const end = text.startsWith(".\r\n") ? 0 : text.indexOf("\r\n.\r\n");
          if (end < 0) { data = text; buffer = ""; return; }
          const message = end === 0 ? "" : text.slice(0, end + 2);
          buffer = text.slice(end === 0 ? 3 : end + 5);
          data = null;
          const raw = Buffer.from(message.replace(/\r\n\.\./g, "\r\n.").replace(/^\.\./, "."), "latin1");
          const id = box.submit(raw, to);
          send(`250 2.0.0 OK  ${Math.floor(box.nowMs / 1000)} ${id} - gsmtp`);
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        log?.("C: " + line.slice(0, 200));
        if (authSteps > 0) { authSteps--; send(authSteps ? "334 UGFzc3dvcmQ6" : "235 2.7.0 Accepted"); continue; }
        const [verb, ...rest] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "EHLO": socket.write("250-smtp.gmail.com at your service, [127.0.0.1]\r\n250-SIZE 35882577\r\n250-8BITMIME\r\n250-AUTH LOGIN PLAIN XOAUTH2 PLAIN-CLIENTTOKEN OAUTHBEARER XOAUTH\r\n250-ENHANCEDSTATUSCODES\r\n250-PIPELINING\r\n250-CHUNKING\r\n250 SMTPUTF8\r\n"); break;
          case "HELO": send("250 smtp.gmail.com at your service"); break;
          case "AUTH":
            if (rest.length > 1) send("235 2.7.0 Accepted");
            else if (rest[0]?.toUpperCase() === "LOGIN") { authSteps = 2; send("334 VXNlcm5hbWU6"); }
            else { authSteps = 1; send("334 "); }
            break;
          case "MAIL": to = []; send("250 2.1.0 OK - gsmtp"); break;
          case "RCPT": to.push((/<([^>]*)>/.exec(line) ?? [])[1] ?? ""); send("250 2.1.5 OK - gsmtp"); break;
          case "DATA": data = ""; send("354 Go ahead - gsmtp"); break;
          case "RSET": to = []; send("250 2.1.5 Flushed - gsmtp"); break;
          case "NOOP": send("250 2.0.0 OK - gsmtp"); break;
          case "QUIT": send("221 2.0.0 closing connection - gsmtp"); socket.end(); return;
          default: send("502 5.5.1 Unrecognized command. - gsmtp");
        }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise(r => server.close(() => r())) })));
}
