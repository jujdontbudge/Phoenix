import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readMark } from "@phoenix/capture";
import { composeMadeUp, createSessionMoment, type SessionAnswer } from "@phoenix/setup";
import { digest } from "@phoenix/store";
import { stripSecrets } from "@phoenix/redact";
import { importTranscript, readRecipe } from "@phoenix/transcripts";
import { transcriptCapture } from "./transcript-options.ts";

const USAGE = [
  "Usage: phoenix moment create --session <session-file> --recipe <recipe.yaml> (--at <line> | --from-beginning) [--change-answer <line>=<file> ...] --id <id> --check <check.yaml> [--timezone <tz>] [--home <dir>] <out-dir>",
  "       phoenix moment create --mark <mark-dir> [--at <line> | --from-beginning] --id <id> --check <check.yaml> [--timezone <tz>] [--home <dir>] <out-dir>",
  "       phoenix moment create --made-up <folder> --recipe <recipe.yaml> --id <id> [--check <check.yaml>] [--home <dir>] <out-dir>",
].join("\n");

export async function runMomentSessionCommand(args: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    session: { type: "string" }, mark: { type: "string" }, "made-up": { type: "string" }, recipe: { type: "string" }, at: { type: "string" }, "from-beginning": { type: "boolean" },
    "change-answer": { type: "string", multiple: true }, id: { type: "string" }, check: { type: "string" }, timezone: { type: "string" }, home: { type: "string" },
  } });
  const [out, ...rest] = positionals;
  const sources = [v.session, v.mark, v["made-up"]].filter(source => source !== undefined);
  if (!out || rest.length || sources.length !== 1 || !v.id || (v.at !== undefined && v["from-beginning"])) throw new Error(USAGE);
  const home = resolve(v.home ?? process.env.PHOENIX_HOME ?? join(homedir(), ".phoenix"));
  let session = v.session, recipePath = v.recipe, at = v.at === undefined ? undefined : Number(v.at), fromBeginning = !!v["from-beginning"], check = v.check, timezone = v.timezone;
  let answers: SessionAnswer[] = [], marked, project, madeUp = false, world: Record<string, unknown> | undefined, readOnly: Record<string, string[]> | undefined;
  if (v.mark) {
    const read = await readMark(resolve(v.mark));
    session = read.session; recipePath ??= read.mark.recipe;
    if (at === undefined && !fromBeginning) at = read.mark.line;
    answers = read.services.map((answer, index) => ({ id: `mark-${index + 1}`, ...answer, before_cut: false, world: "exact" as const }));
    readOnly = read.mark.read_only;
    marked = { at: read.mark.at, ...(read.mark.note ? { note: read.mark.note } : {}), world: read.mark.world };
    if (read.project && read.mark.world.files === "saved") project = { ...read.project, taken_at: read.mark.at };
    world = { files: read.mark.world.files === "saved" ? `saved at the mark, ${read.mark.at}` : "not saved: this moment was marked after the fact, so the replay does not see the files as they were then", services: read.mark.world.services, session: session === read.mark.session.path ? "the live session file, unchanged up to the mark" : "the copy saved at the mark" };
  }
  if (!recipePath || (!v["made-up"] && at === undefined && !fromBeginning) || (!v["made-up"] && !check)) throw new Error(USAGE);
  const reader = await readRecipe(recipePath);
  const recipe = { directory: reader.directory, descriptor: reader.recipe };
  if (v["made-up"]) {
    const folder = resolve(v["made-up"]);
    const composed = await composeMadeUp({ from: folder, recipe, out: join(home, "made-up", v.id) });
    session = composed.session; at = composed.at; fromBeginning = !!composed.fromBeginning; answers = composed.answers; madeUp = true;
    check ??= join(folder, "check.yaml"); timezone ??= composed.timezone;
  }
  const changes = (v["change-answer"] ?? []).map(change => {
    const split = change.indexOf("=");
    const line = Number(change.slice(0, split));
    if (split < 1 || !Number.isInteger(line)) throw new Error(`--change-answer must be <line>=<file>: ${change}`);
    return { line, file: change.slice(split + 1) };
  });
  const identity = `import-${digest(Buffer.from(JSON.stringify([reader.recipe.name, resolve(session!)]))).slice(7)}`;
  const capture = await transcriptCapture({ "--home": home }, identity, reader.recipe.name, reader.recipe.name);
  let imported = await importTranscript({ ...capture, source: session!, reader });
  if (!imported.complete && !imported.added) {
    await rm(join(capture.root, imported.segment));
    imported = await importTranscript({ ...capture, source: session!, reader });
  }
  if (!imported.complete) throw new Error(`The ${reader.recipe.name} transcript reader could not read all of the session: ${imported.issues.map(i => i.reason).join("; ")}`);
  for (const answer of answers) {
    const { msg } = await stripSecrets({ body: Buffer.from(JSON.stringify(answer.result)) }, capture.policy);
    if (msg.secrets === "unscanned") throw new Error("A saved tool answer could not be scanned for secrets");
    answer.result = JSON.parse(Buffer.from(msg.body!).toString("utf8"));
  }
  const manifest = await createSessionMoment({
    recipe, session: session!, capture: capture.root, ...(fromBeginning ? { fromBeginning } : { at: at! }), changes, answers, ...(readOnly ? { readOnly } : {}), ...(marked ? { marked } : {}), ...(project ? { project } : {}), madeUp,
    id: v.id, check: check!, out, policy: capture.policy, ...(timezone ? { timezone } : {}),
  });
  process.stdout.write(JSON.stringify({ moment: manifest.id, bundle: out, resumes: manifest.resume, ...(world ? { world } : {}), next: `Read ${out}/check.draft.yaml, then run phoenix check approve ${out}` }) + "\n");
  return 0;
}
