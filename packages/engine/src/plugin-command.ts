import type { PluginDescriptor } from "@phoenix/formats";
import { isReadOnly } from "@phoenix/answer";
import { lex } from "./read-only-shell.ts";

export type CommandPlugin = Pick<PluginDescriptor, "connector" | "recognize" | "read_only">;
export interface RecognizedCommand { connector: string; argv: string[]; env?: Record<string, string>; stdin?: string; readOnly: boolean; conditional: boolean }
/**
 * calls are the plugin commands in the line, in order; a conditional one runs only if an earlier && or || in its
 * ;-separated part of the line lets it.
 * around is the line with the i-th plugin command written as
 * a NUL, i, NUL marker and every other word single-quoted, so it reads as the same shell line once each marker is
 * replaced by something that prints that command's output; a line that is one plugin command alone is just its marker.
 */
export interface RecognizedLine { calls: RecognizedCommand[]; around: string }

export const marker = (i: number): string => `\u0000${i}\u0000`;
const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][A-Za-z0-9_]*))[ \t]*\n/;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };
const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["sh", "bash", "/bin/sh", "/bin/bash", "/usr/bin/bash"]);

function heredoc(command: string): { line: string; stdin?: string } | undefined {
  const opened = HEREDOC.exec(command);
  if (!opened) return command.includes("<<") ? undefined : { line: command };
  const [, strip, single, double, bare] = opened;
  const delimiter = single ?? double ?? bare!;
  const lines = command.slice(opened.index + opened[0].length).split("\n");
  const end = lines.findIndex(line => (strip ? line.replace(/^\t+/, "") : line) === delimiter);
  if (end < 0 || lines.slice(end + 1).some(line => line.trim())) return undefined;
  const body = lines.slice(0, end).map(line => strip ? line.replace(/^\t+/, "") : line);
  if (bare && body.some(line => /[$`\\]/.test(line))) return undefined;
  return { line: command.slice(0, opened.index), stdin: body.map(line => line + "\n").join("") };
}

function printed([name, ...args]: string[]): string | undefined {
  if (name === "echo") {
    const plain = args[0] === "-n" ? args.slice(1) : args;
    if (plain[0]?.startsWith("-")) return undefined;
    return plain.join(" ") + (args[0] === "-n" ? "" : "\n");
  }
  if (name !== "printf" || args[0] === undefined || args[0].startsWith("-")) return undefined;
  const [format, ...values] = args;
  let out = "", at = 0, from = -1;
  do {
    from = at;
    for (let i = 0; i < format.length; i++) {
      const c = format[i]!, next = format[i + 1];
      if (c === "\\" && next !== undefined && Object.hasOwn(ESCAPES, next)) { out += ESCAPES[next]; i++; }
      else if (c === "%" && next === "%") { out += "%"; i++; }
      else if (c === "%" && next === "s") { out += values[at++] ?? ""; i++; }
      else if (c === "%" || c === "\\") return undefined;
      else out += c;
    }
  } while (at < values.length && at > from);
  return out;
}

/**
 * The plugin commands in a shell command line: for each, which plugin it belongs to, the argv, environment
 * assignments and stdin that plugin's command gets, and whether the plugin's read-only rules call it a read.
 * home, when given, is what a leading ~ means. A line that is only sh -c or bash -c with a literal body is read
 * as that body. It reads only the command line,
 * so it works on a session's past commands as well as new ones. A line with no plugin command, or one it cannot take
 * apart exactly (expansions, input redirections, or input piped into a plugin command from anything but echo or
 * printf of plain text), gives undefined.
 */
export function recognizeCommand(command: string, plugins: readonly CommandPlugin[], home?: string): RecognizedLine | undefined {
  if (command.includes("\u0000")) return undefined;
  const split = heredoc(command);
  const tokens = split && lex(split.line.trimEnd(), home);
  if (!tokens?.length) return undefined;
  const [shell, flag, body, ...more] = tokens;
  if (shell && "text" in shell && SHELLS.has(shell.text) && flag && "text" in flag && /^-(c|lc|cl)$/.test(flag.text) && body && "text" in body && split!.stdin === undefined
    && (!more.length || (more.length === 2 && "op" in more[0]! && more[0].op === "<" && "text" in more[1]! && more[1].text === "/dev/null")))
    return recognizeCommand(body.text, plugins, home);
  type Simple = { words: string[]; redirects: string[]; before?: string };
  const simple: Simple[] = [{ words: [], redirects: [] }];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if ("text" in token) { simple.at(-1)!.words.push(token.text); continue; }
    if (["|", "&&", "||", ";"].includes(token.op)) {
      if (!simple.at(-1)!.words.length) return undefined;
      simple.push({ words: [], redirects: [], before: token.op });
      continue;
    }
    const target = tokens[at + 1];
    if (!target || !("text" in target) || token.op.includes("<")) return undefined;
    simple.at(-1)!.redirects.push(token.op, quote(target.text));
    at++;
  }
  if (!simple.at(-1)!.words.length) { if (simple.at(-1)!.before !== ";") return undefined; simple.pop(); }
  const owner = (words: string[]) => {
    const argv = words.slice(words.findIndex(word => !ASSIGNMENT.test(word)));
    return plugins.find(p => argv[0] !== undefined && !ASSIGNMENT.test(argv[0]) && p.recognize.commands?.includes(argv[0]));
  };
  const calls: RecognizedCommand[] = [];
  const parts: string[] = [];
  let conditional = false;
  for (const [i, { words, redirects, before }] of simple.entries()) {
    const plugin = owner(words);
    conditional = before === "&&" || before === "||" || (conditional && before === "|");
    if (before) parts.push(before);
    if (!plugin) { parts.push([...words.map(quote), ...redirects].join(" ")); continue; }
    let stdin = split!.stdin;
    if (stdin !== undefined && simple.length > 1) return undefined;
    if (before === "|") {
      const source = simple[i - 1]!;
      stdin = source.before === "|" || source.redirects.length || owner(source.words) ? undefined : printed(source.words);
      if (stdin === undefined) return undefined;
      parts.splice(-2);
    }
    const assigned = words.findIndex(word => !ASSIGNMENT.test(word));
    const argv = words.slice(assigned);
    const env = Object.fromEntries(words.slice(0, assigned).map(word => [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]));
    const readOnly = isReadOnly({ read_only: (plugin.read_only ?? []).map(op => ({ op, source: "plugin" as const })) }, "cli", argv[0]!, { argv });
    calls.push({ connector: plugin.connector, argv, ...(assigned ? { env } : {}), ...(stdin === undefined ? {} : { stdin }), readOnly, conditional });
    parts.push([marker(calls.length - 1), ...redirects].join(" "));
  }
  return calls.length ? { calls, around: parts.join(" ") } : undefined;
}
