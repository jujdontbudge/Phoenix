import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

type Operands = "paths" | "text" | "pattern" | "sed" | "find" | "none" | "dir";
type Spec = { flags?: string; valued?: string; long?: string[]; numeric?: boolean; operands: Operands; max?: number };

const GREP_LONG = ["--include=", "--exclude=", "--exclude-dir=", "--color", "--colour", "--line-number", "--recursive", "--ignore-case", "--count", "--files-with-matches", "--files-without-match", "--fixed-strings", "--extended-regexp", "--invert-match", "--word-regexp", "--line-regexp", "--no-filename", "--with-filename", "--max-count=", "--context=", "--after-context=", "--before-context=", "--only-matching", "--quiet", "--silent", "--no-messages", "--binary-files="];
const RG_LONG = ["--files", "--hidden", "--no-ignore", "--glob=", "--iglob=", "--type=", "--type-not=", "--line-number", "--no-line-number", "--no-heading", "--heading", "--color=", "--count", "--count-matches", "--files-with-matches", "--files-without-match", "--fixed-strings", "--ignore-case", "--smart-case", "--case-sensitive", "--max-count=", "--context=", "--after-context=", "--before-context=", "--max-depth=", "--word-regexp", "--line-regexp", "--invert-match", "--json", "--sort=", "--trim", "--only-matching", "--no-filename", "--with-filename", "--column", "--vimgrep", "--max-columns=", "--multiline", "--regexp="];
const SPECS: Record<string, Spec> = {
  cat: { flags: "nbsAvETetu", operands: "paths" },
  ls: { flags: "1aAbBcCdfFghiklmnopqrRsStuUvwxX", long: ["--all", "--almost-all", "--human-readable", "--classify", "--color", "--color="], operands: "paths" },
  head: { flags: "qv", valued: "nc", numeric: true, operands: "paths" },
  tail: { flags: "qv", valued: "nc", numeric: true, operands: "paths" },
  wc: { flags: "lwcmL", operands: "paths" },
  grep: { flags: "iIvwxcnlLhHrsqoEFGPaZz", valued: "emABC", long: GREP_LONG, operands: "pattern" },
  egrep: { flags: "iIvwxcnlLhHrsqoaZz", valued: "emABC", long: GREP_LONG, operands: "pattern" },
  fgrep: { flags: "iIvwxcnlLhHrsqoaZz", valued: "emABC", long: GREP_LONG, operands: "pattern" },
  rg: { flags: "iISsnNlcwxuvHFoq0U", valued: "egtTmABCM", long: RG_LONG, operands: "pattern" },
  find: { operands: "find" },
  stat: { flags: "Lft", valued: "c", long: ["--format=", "--terse", "--dereference", "--file-system"], operands: "paths" },
  pwd: { flags: "LP", operands: "none" },
  true: { operands: "none" },
  cd: { operands: "dir", max: 1 },
  sed: { flags: "nErsuz", valued: "e", operands: "sed" },
  sort: { flags: "bdfgiMhnRrsuVcCz", valued: "kt", operands: "paths" },
  uniq: { flags: "cdDiuz", valued: "fsw", operands: "paths", max: 1 },
  cut: { flags: "sz", valued: "dfcb", long: ["--complement"], operands: "paths" },
  tr: { flags: "cCdst", operands: "text" },
  nl: { flags: "p", valued: "bdfhinsvlw", operands: "paths" },
  echo: { flags: "neE", operands: "text" },
  basename: { flags: "az", valued: "s", operands: "text" },
  dirname: { flags: "z", operands: "text" },
  realpath: { flags: "emsqz", operands: "paths" },
  du: { flags: "sahckmx", valued: "d", long: ["--max-depth=", "--summarize", "--human-readable"], operands: "paths" },
};
const FIND_VALUED = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-perm", "-user", "-group", "-regex", "-iregex"]);
const FIND_PLAIN = new Set(["-print", "-print0", "-empty", "-prune", "-not", "!", "-o", "-a", "-or", "-and", "-true", "-false", "-depth", "-xdev"]);
const SED_PRINT = /^\s*(\d+|\$)?\s*(,\s*(\d+|\$)\s*)?p\s*$/;

type Word = { text: string };
type Token = Word | { op: string };

export function lex(command: string, home?: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word: Word | undefined;
  const end = () => { if (word) tokens.push(word); word = undefined; };
  for (let at = 0; at < command.length; at++) {
    const c = command[at]!;
    if (c === "'") {
      const close = command.indexOf("'", at + 1);
      if (close < 0) return undefined;
      word = { text: (word?.text ?? "") + command.slice(at + 1, close) };
      at = close;
    } else if (c === '"') {
      let text = "";
      for (at++; command[at] !== '"'; at++) {
        if (at >= command.length || command[at] === "$" || command[at] === "`") return undefined;
        if (command[at] === "\\" && '"\\'.includes(command[at + 1] ?? "")) at++;
        text += command[at];
      }
      word = { text: (word?.text ?? "") + text };
    } else if (c === "\\") {
      if (command[at + 1] === "\n") { at++; continue; }
      if (at + 1 >= command.length) return undefined;
      word = { text: (word?.text ?? "") + command[++at] };
    } else if (c === " " || c === "\t") end();
    else if ("|&;<>\n".includes(c)) {
      const fd = word && /^[12]$/.test(word.text) && c === ">" && !/\S/.test(command[at - 2] ?? "") && /\d/.test(command[at - 1] ?? "") ? word.text : "";
      if (fd) word = undefined; else end();
      let op = c === "\n" ? ";" : c;
      while (at + 1 < command.length && "|&<>".includes(command[at + 1]!) && op.length < 2) op += command[++at];
      tokens.push({ op: fd + op });
    } else if (c === "~" && home && !word && (at + 1 === command.length || "/ \t|&;<>\n".includes(command[at + 1]!))) word = { text: home };
    else if ("$`(){}#*?[~".includes(c)) return undefined;
    else word = { text: (word?.text ?? "") + c };
  }
  end();
  return tokens;
}

function parse(spec: Spec, args: string[]): { operands: string[]; values: Map<string, string[]> } | undefined {
  const operands: string[] = [], values = new Map<string, string[]>();
  const add = (key: string, value: string) => values.set(key, [...values.get(key) ?? [], value]);
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") { operands.push(...args.slice(at + 1)); break; }
    if (arg === "-" || !arg.startsWith("-")) { operands.push(arg); continue; }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (equals >= 0) { if (!spec.long?.includes(name + "=")) return undefined; add(name, arg.slice(equals + 1)); continue; }
      if (spec.long?.includes(name)) continue;
      if (!spec.long?.includes(name + "=") || at + 1 >= args.length) return undefined;
      add(name, args[++at]!);
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(arg)) continue;
    for (let i = 1; i < arg.length; i++) {
      const letter = arg[i]!;
      if (spec.flags?.includes(letter)) continue;
      if (!spec.valued?.includes(letter)) return undefined;
      const value = i + 1 < arg.length ? arg.slice(i + 1) : args[++at];
      if (value === undefined) return undefined;
      add("-" + letter, value);
      break;
    }
  }
  return { operands, values };
}

/**
 * Whether a shell command only reads files and folders under root, so it can run for real on a copy of them.
 * root is the folder as the session saw it; copy is where those files are on this machine (root itself by default),
 * used to refuse paths that leave the copy through a symlink.
 */
export function readsOnly(command: string, root: string, cwd: string = root, copy: string = root): boolean {
  const tokens = lex(command);
  const last = tokens?.at(-1);
  if (!tokens?.some(token => "text" in token) || (last && "op" in last && last.op !== ";")) return false;
  const top = existsSync(copy) ? realpathSync(copy) : copy;
  const real = (path: string) => existsSync(path) ? realpathSync(path) : path;
  const under = (path: string) => { const rest = relative(top, path); return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest)); };
  const locate = (from: string, path: string, links = true): string | undefined => {
    let at = from, rest = path;
    if (isAbsolute(path)) {
      if (path !== root && !path.startsWith(root.endsWith("/") ? root : root + "/")) return undefined;
      at = top;
      rest = path.slice(root.length);
    }
    for (const part of rest.split("/")) {
      if (!part || part === ".") continue;
      const next = part === ".." ? dirname(at) : join(at, part);
      at = part === ".." ? next : real(next);
      if (!under(at) || (!links && at !== next)) return undefined;
    }
    return at;
  };
  let here = locate(top, isAbsolute(cwd) ? cwd : root + "/" + cwd, false);
  if (!here) return false;
  const commands: { words: string[]; before?: string; after?: string }[] = [{ words: [] }];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if ("text" in token) { commands.at(-1)!.words.push(token.text); continue; }
    if (["|", "&&", "||", ";"].includes(token.op)) {
      if (!commands.at(-1)!.words.length) return false;
      commands.at(-1)!.after = token.op;
      commands.push({ words: [], before: token.op });
      continue;
    }
    const target = tokens[at + 1];
    if (!target || !("text" in target)) return false;
    if (/^[12]?>&$/.test(token.op) ? !/^[12]$/.test(target.text) : !(/^([12]?>>?|&>)$/.test(token.op) && target.text === "/dev/null")) return false;
    at++;
  }
  if (!commands.at(-1)!.words.length) commands.pop();
  const changesDirectory = commands.some(({ words }) => words[0] === "cd");
  if (changesDirectory && tokens.some(token => "op" in token && (token.op === "||" || token.op === ";"))) return false;
  for (const { words: [name, ...args], before, after } of commands) {
    if (!Object.hasOwn(SPECS, name!)) return false;
    const spec = SPECS[name!]!;
    const parsed = parse(spec, name === "find" ? [] : args);
    if (!parsed) return false;
    let { operands } = parsed;
    const paths: string[] = [];
    if (spec.operands === "paths") paths.push(...operands);
    else if (spec.operands === "none" && operands.length) return false;
    else if (spec.operands === "pattern") paths.push(...(parsed.values.has("-e") || parsed.values.has("--regexp") || parsed.values.has("--files") || args.includes("--files") ? operands : operands.slice(1)));
    else if (spec.operands === "sed") {
      const scripts = parsed.values.get("-e") ?? operands.slice(0, 1);
      if (!args.some(arg => /^-[a-z]*n/i.test(arg) && !arg.startsWith("--")) || !scripts.length || !scripts.every(script => SED_PRINT.test(script))) return false;
      paths.push(...(parsed.values.has("-e") ? operands : operands.slice(1)));
    } else if (spec.operands === "find") {
      let at = 0;
      while (at < args.length && !args[at]!.startsWith("-") && args[at] !== "!") paths.push(args[at++]!);
      for (; at < args.length; at++) {
        const arg = args[at]!;
        if (arg === "-newer") { if (at + 1 >= args.length) return false; paths.push(args[++at]!); }
        else if (FIND_VALUED.has(arg)) { if (++at >= args.length) return false; }
        else if (!FIND_PLAIN.has(arg)) return false;
      }
    } else if (spec.operands === "dir") {
      if (operands.length !== 1 || operands[0] === "-" || (before && before !== "&&") || after !== "&&") return false;
      paths.push(operands[0]!);
    }
    if (spec.max !== undefined && operands.length > spec.max) return false;
    if (!paths.every(path => path === "/dev/null" || locate(here!, path))) return false;
    if (name === "cd") { here = locate(here, operands[0]!, false); if (!here) return false; }
  }
  return true;
}
