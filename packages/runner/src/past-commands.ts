import { recognizeCommand, type CommandPlugin } from "@phoenix/engine";

/** How a harness's shell tool is read: its command and cwd arguments, and where its result holds the printed output and the exit code. */
export interface ShellTool {
  command: string;
  cwd?: string;
  /** JSON pointer into the result for the printed output; the result's text blocks when absent or not found. */
  output?: string;
  /** JSON pointer into the result for the exit code, or "isError" when the harness fails the call on a nonzero exit. */
  exit?: string;
}
interface PastAnswer { connector: string; op: string; args: unknown; result: unknown; observed_at: string; before_cut: boolean }

const pointer = (value: unknown, path: string): unknown => path.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))
  .reduce<unknown>((at, key) => at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined, value);

/**
 * A session's shell call from before the cut that is one command a plugin's recognize.commands claims, alone on its
 * line, as capture events of that command: its argv as recognized, stdin when the line gave it, what it printed, and
 * its exit code when the session has it. A line the recognizer cannot read exactly gives nothing. The command belongs
 * to the first of the claimants that claims it, the same order a new command is routed by.
 */
export function pastCommand(answer: PastAnswer, shell: ShellTool | undefined, plugin: CommandPlugin, cwd: string | undefined, base: { capture: string; stream: string; connector: string }, claimants: CommandPlugin[] = [plugin]): object[] {
  if (!shell || !answer.before_cut) return [];
  const given = answer.args as Record<string, unknown>;
  const command = given?.[shell.command];
  const line = typeof command === "string" ? recognizeCommand(command, claimants) : undefined;
  const call = line?.calls.length === 1 && line.around === "\u00000\u0000" ? line.calls[0]! : undefined;
  if (!call || call.connector !== plugin.connector) return [];
  const result = answer.result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.filter(block => block.type === "text").map(block => block.text ?? "").join("");
  const found = shell.output ? pointer(result, shell.output) : undefined;
  const output = typeof found === "string" ? found : text;
  const exit = shell.exit === "isError" ? (result?.isError === false ? 0 : undefined) : shell.exit ? pointer(result, shell.exit) : undefined;
  if (typeof output !== "string") return [];
  const at = typeof given[shell.cwd ?? ""] === "string" ? given[shell.cwd!] as string : cwd ?? "/";
  const event = (seq: number, kind: string, op: string, inline: string) => ({ v: 1, ...base, seq, ts: { wall: answer.observed_at }, kind, surface: "cli", op, body: { inline } });
  const events = [event(0, "call", call.argv[0]!, JSON.stringify({ argv: call.argv, cwd: at, env: {}, terminals: { stdin: null, stdout: null, stderr: null } }))];
  if (call.stdin !== undefined) events.push(event(events.length, "call", "frame:out:0", call.stdin));
  events.push(event(events.length, "result", "frame:back:1", output));
  if (typeof exit === "number") events.push(event(events.length, "result", "frame:back:3", JSON.stringify({ type: "exit", code: exit, signal: null })));
  return events;
}
