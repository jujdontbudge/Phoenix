// A small MIME reader and writer: enough to turn a stored RFC 822 message into the fields the
// Gmail connector and IMAP clients show, and to write the messages the copy creates.

const decoder = charset => { try { return new TextDecoder(charset || "utf-8"); } catch { return new TextDecoder("utf-8"); } };

export function decodeWords(value) {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset, kind, text) => {
    const bytes = kind.toUpperCase() === "B" ? Buffer.from(text, "base64") : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return decoder(charset).decode(bytes);
  });
}

export function splitHead(raw) {
  const text = raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const bodyStart = end < 0 ? text.length : end + text.slice(end).match(/^\r?\n\r?\n/)[0].length;
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) headers.at(-1)[1] += " " + line.trim();
    else if (line.includes(":")) headers.push([line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]);
  }
  return { headers, head: raw.subarray(0, Buffer.byteLength(head, "latin1")), body: raw.subarray(bodyStart) };
}

export const header = (headers, name) => headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

function params(value = "") {
  const [type, ...rest] = value.split(";");
  const out = { type: type.trim().toLowerCase() };
  for (const part of rest) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function decodeBody(body, encoding = "") {
  const e = encoding.toLowerCase();
  if (e === "base64") return Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64");
  if (e === "quoted-printable") return Buffer.from(body.toString("latin1").replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  return body;
}

// Returns the leaf parts of a message in document order.
export function parts(raw) {
  const { headers, body } = splitHead(raw);
  const type = params(header(headers, "content-type") ?? "text/plain");
  if (type.type.startsWith("multipart/") && type.boundary) {
    const text = body.toString("latin1");
    const marker = "--" + type.boundary;
    const out = [];
    for (const chunk of text.split(marker).slice(1)) {
      if (chunk.startsWith("--")) break;
      out.push(...parts(Buffer.from(chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), "latin1")));
    }
    return out;
  }
  const disposition = params(header(headers, "content-disposition") ?? "");
  const bytes = decodeBody(body, header(headers, "content-transfer-encoding"));
  return [{ type: type.type, charset: type.charset, filename: disposition.filename ? decodeWords(disposition.filename) : type.name ? decodeWords(type.name) : undefined, disposition: disposition.type, bytes, text: type.type.startsWith("text/") ? decoder(type.charset).decode(bytes) : undefined }];
}

export function addresses(value = "") {
  const out = [];
  for (const piece of decodeWords(value).match(/(?:[^,"]|"[^"]*")+/g) ?? []) {
    const angle = /^(.*)<([^>]+)>\s*$/.exec(piece.trim());
    if (angle) out.push({ name: angle[1].trim().replace(/^"(.*)"$/, "$1"), email: angle[2].trim() });
    else if (piece.trim()) out.push({ name: "", email: piece.trim() });
  }
  return out;
}

const crlf = text => text.replace(/\r?\n/g, "\r\n");
const encodeWord = text => /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
const qp = text => Buffer.from(text, "utf8").toString("latin1").split(/\r?\n/).map(line => {
  let out = "", width = 0;
  for (const ch of line) {
    const code = ch.charCodeAt(0);
    const piece = code > 126 || ch === "=" ? `=${code.toString(16).toUpperCase().padStart(2, "0")}` : ch;
    if (width + piece.length > 75) { out += "=\r\n"; width = 0; }
    out += piece; width += piece.length;
  }
  return out.replace(/ $/, "=20");
}).join("\r\n");
const formatAddress = a => !a.name ? a.email : /^[\x20-\x7e]*$/.test(a.name) && /[()<>[\]:;@\\,."]/.test(a.name) ? `"${a.name.replace(/(["\\])/g, "\\$1")}" <${a.email}>` : `${encodeWord(a.name)} <${a.email}>`;

// Writes a message the way Gmail writes a plain message sent from its API: text and HTML alternatives.
export function buildMessage({ from, to = [], cc = [], bcc = [], subject = "", text, html, date, messageId, inReplyTo, references, boundary, receivedFrom }) {
  const head = [
    ...(receivedFrom ? [`Received: from ${receivedFrom}\r\n\tnamed unknown\r\n\tby gmailapi.google.com\r\n\twith HTTPREST;\r\n\t${date}`] : []),
    `Date: ${date}`,
    ...(to.length ? [`To: ${to.map(formatAddress).join(", ")}`] : []),
    ...(cc.length ? [`Cc: ${cc.map(formatAddress).join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.map(formatAddress).join(", ")}`] : []),
    `Message-Id: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references ?? inReplyTo}`] : []),
    `Subject: ${encodeWord(subject)}`,
    "MIME-Version: 1.0",
    text === undefined ? "Content-Type: text/html; charset=UTF-8" : `Content-Type: multipart/alternative; \r\n\tboundary="${boundary}"`,
    `From: ${formatAddress(from)}`,
  ];
  if (text === undefined) return Buffer.from(head.join("\r\n") + "\r\n\r\n" + crlf(html ?? ""), "utf8");
  const body = [
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8; format=flowed", "Content-Transfer-Encoding: quoted-printable", "", qp(text ?? ""),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: 7bit", "", crlf(html ?? ""),
    `--${boundary}--`, "",
  ];
  return Buffer.from(head.join("\r\n") + "\r\n\r\n" + body.join("\r\n"), "utf8");
}

export function rfc2822(date, timeZone, fixed) {
  let offset = fixed;
  if (!offset) {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date).find(p => p.type === "timeZoneName").value;
    offset = name === "GMT" ? "+0000" : name.slice(3).replace(":", "");
  }
  const sign = offset.startsWith("-") ? -1 : 1, minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  const shifted = new Date(date.getTime() + minutes * 60e3);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][shifted.getUTCDay()], month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][shifted.getUTCMonth()];
  const two = n => String(n).padStart(2, "0");
  return `${day}, ${two(shifted.getUTCDate())} ${month} ${shifted.getUTCFullYear()} ${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}:${two(shifted.getUTCSeconds())} ${offset}`;
}
