// Runs the real himalaya command against the copy's IMAP and SMTP servers. Only the account's
// connection settings are replaced; every other setting comes from the person's own config.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startImap, startSmtp } from "./imap.mjs";

const tomlString = s => JSON.stringify(String(s));
// himalaya's own folder names (Sent, Trash, Drafts) do not exist on Gmail, so a person's working
// Gmail setup names Gmail's folders. Used when the snapshot carries no himalaya settings.
const GMAIL_FOLDERS = ['folder.aliases.inbox = "INBOX"', 'folder.aliases.sent = "[Gmail]/Sent Mail"', 'folder.aliases.drafts = "[Gmail]/Drafts"', 'folder.aliases.trash = "[Gmail]/Trash"'];

// The folder names himalaya resolves for the default account, by lower-case alias.
export function folderAliases(settings) {
  const accounts = settings?.accounts ?? [{ lines: GMAIL_FOLDERS, default: true }];
  const account = accounts.find(a => a.default) ?? accounts[0];
  return Object.fromEntries((account?.lines ?? []).map(line => /^\s*folder\.aliases\.([\w-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line)).filter(Boolean).map(([, key, value]) => [key.toLowerCase(), JSON.parse('"' + value + '"')]));
}
const LOG = process.env.PHOENIX_EMAIL_LOG;

export class Himalaya {
  constructor(box, settings = {}) { this.box = box; this.settings = settings ?? {}; }

  async start() {
    const log = LOG ? line => process.stderr.write(line + "\n") : undefined;
    this.imap = await startImap(this.box, { log });
    this.smtp = await startSmtp(this.box, { log });
    this.home = await mkdtemp(join(tmpdir(), "phoenix-email-"));
    this.config = join(this.home, "config.toml");
    this.configure();
  }

  // The account's address can be learned after the copy starts, so the config follows it.
  configure() {
    this.email = this.box.account.email;
    const accounts = this.settings.accounts ?? [{ name: "gmail", lines: GMAIL_FOLDERS, default: true }];
    const body = accounts.map(account => [
      `[accounts.${account.name}]`,
      `email = ${tomlString(this.box.account.email)}`,
      ...(account.lines ?? []).filter(line => !/^\s*(email\s*=|backend\.|message\.send\.backend\.)/.test(line)),
      ...(account.lines?.some(l => /^\s*default\s*=/.test(l)) || !account.default ? [] : ["default = true"]),
      'backend.type = "imap"', 'backend.host = "127.0.0.1"', `backend.port = ${this.imap.port}`, 'backend.encryption.type = "none"',
      `backend.login = ${tomlString(this.box.account.email)}`, 'backend.auth.type = "password"', 'backend.auth.raw = "phoenix-copy"',
      'message.send.backend.type = "smtp"', 'message.send.backend.host = "127.0.0.1"', `message.send.backend.port = ${this.smtp.port}`, 'message.send.backend.encryption.type = "none"',
      `message.send.backend.login = ${tomlString(this.box.account.email)}`, 'message.send.backend.auth.type = "password"', 'message.send.backend.auth.raw = "phoenix-copy"',
      "",
    ].join("\n")).join("\n");
    writeFileSync(this.config, [...(this.settings.top ?? []), "", body].join("\n"), { mode: 0o600 });
  }

  // The person's own -c paths point at files outside the copy, so they are dropped.
  argv(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      const a = String(argv[i]);
      if (a === "-c" || a === "--config") { i++; continue; }
      if (a.startsWith("--config=")) continue;
      out.push(a);
    }
    return out;
  }

  run(argv, stdin, nowMs) {
    this.box.nowMs = nowMs;
    if (this.box.account.email !== this.email) this.configure();
    return new Promise(resolve => {
      const child = spawn(process.env.PHOENIX_HIMALAYA ?? "himalaya", ["-c", this.config, ...this.argv(argv)], {
        cwd: this.home, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "LD_PRELOAD" || k.startsWith("FAKETIME"))), PATH: process.env.PATH, HOME: this.home, TZ: this.box.timezone, LANG: process.env.LANG ?? "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out = [], err = [];
      child.stdout.on("data", c => out.push(c));
      child.stderr.on("data", c => err.push(c));
      child.on("error", error => resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from(error.message), code: 127 }));
      child.on("close", code => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? 1 }));
      child.stdin.end(stdin ?? "");
    });
  }

  async stop() {
    await this.imap?.close(); await this.smtp?.close();
    if (this.home) await rm(this.home, { recursive: true, force: true });
  }
}
