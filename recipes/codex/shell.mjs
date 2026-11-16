#!/usr/bin/env node
// Stands in for the user's shell inside the box. Codex runs each command as `<shell> -lc <command>`;
// Phoenix answers it from the session, or says to run it for real on the copy of the project's files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
if (flag < 0 || args[flag + 1] === undefined) {
  process.stderr.write("Phoenix's stand-in shell only answers commands given with -c\n");
  process.exit(127);
}
const ask = (method, params) => fetch(`${process.env.PHOENIX_TOOLS_URL ?? "http://phoenix-tools"}/codex-shell`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 0, method, params: { name: "exec", ...params } }),
}).then(response => response.json());
const command = args[flag + 1];
const reply = await ask("tools/call", { arguments: { command, cwd: process.cwd() } });
if (reply.run_in_box) {
  const ran = spawnSync("/usr/local/lib/phoenix-dash", ["-c", command], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = (ran.stdout ?? "") + (ran.stderr ?? "");
  await ask("phoenix/ran", { result: { output, exit_code: ran.status ?? 1, content: [{ type: "text", text: output }], structuredContent: { output, exit_code: ran.status ?? 1 }, isError: ran.status !== 0 } });
  process.stdout.write(ran.stdout ?? "");
  process.stderr.write(ran.stderr ?? "");
  process.exitCode = ran.status ?? 1;
} else if (reply.command_output) {
  const folder = mkdtempSync(join(tmpdir(), "phoenix-output-"));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const printing = ({ command, outputs }) => command.replace(/\u0000(\d+)\u0000/g, (_, i) => {
  const out = join(folder, i + ".out"), err = join(folder, i + ".err");
  writeFileSync(out, outputs[i].stdout);
  writeFileSync(err, outputs[i].stderr);
  return "(cat " + quote(out) + "; cat " + quote(err) + " >&2; exit " + outputs[i].exit_code + ")";
});
  const ran = spawnSync("/usr/local/lib/phoenix-dash", ["-c", printing(reply.command_output)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(ran.stdout ?? "");
  process.stderr.write(ran.stderr ?? "");
  process.exitCode = ran.status ?? 1;
} else if (reply.error) {
  process.stderr.write(`Phoenix stopped this replay: ${reply.error.message}\n`);
  process.exitCode = 1;
} else {
  const { output, exit_code, content, structuredContent, isError } = reply.result;
  process.stdout.write(output ?? structuredContent?.output ?? (content ?? []).map(block => block.text ?? "").join("\n"));
  process.exitCode = exit_code ?? structuredContent?.exit_code ?? (isError ? 1 : 0);
}
