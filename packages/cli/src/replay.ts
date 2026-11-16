import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { Runner, type ReplayRequest } from "@phoenix/runner";

export async function runReplayCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { request: { type: "string" }, home: { type: "string" }, ledger: { type: "string" }, concurrency: { type: "string" } } });
  const home = resolve(values.home ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
  const runner = new Runner({ root: home, ledger: resolve(values.ledger ?? join(home, "approvals.jsonl")), concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency) });
  const [command = "start", id] = positionals;
  if (positionals.length > 2) throw new Error("Too many replay arguments");
  if (command === "status" && id) {
    process.stdout.write(JSON.stringify(await runner.status(id), null, 2) + "\n");
    return 0;
  }
  if (command === "resume" && id) {
    const result = await runner.resume(id);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.verdict === "incomplete" ? 2 : result.meets_check ? 0 : 1;
  }
  if (command === "start" && !id && values.request) {
    const request = JSON.parse(await readFile(resolve(values.request), "utf8")) as ReplayRequest;
    const replay = await runner.plan(request);
    process.stdout.write(JSON.stringify({ replay }) + "\n");
    const result = await runner.resume(replay);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.verdict === "incomplete" ? 2 : result.meets_check ? 0 : 1;
  }
  throw new Error("Usage: phoenix replay start --request <json> | <status|resume> <replay-id> [--home <dir>] [--ledger <file>]");
}

if (import.meta.main) {
  try { process.exitCode = await runReplayCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Replay refused: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; }
}
