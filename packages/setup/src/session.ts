import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, statfs, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import type { MomentManifest, RecipeDescriptor, TraceEvent } from "@phoenix/formats";
import { stripSecrets, type SecretPolicy } from "@phoenix/redact";
import { readCapture, writeMomentBundle } from "@phoenix/store";
import { prepareSnapshotMoment } from "./manual.ts";

const eventId = (e: TraceEvent) => e.id ?? `${e.stream}:${e.seq}`;
const execute = promisify(execFile);

export interface SessionMomentOptions {
  recipe: { directory: string; descriptor: RecipeDescriptor };
  session: string;
  capture: string;
  at?: number;
  fromBeginning?: boolean;
  changes?: readonly { line: number; file: string }[];
  answers?: readonly SessionAnswer[];
  readOnly?: Readonly<Record<string, readonly string[]>>;
  marked?: NonNullable<MomentManifest["resume"]>["marked"];
  project?: { root: string; tar: Buffer; taken_at: string };
  madeUp?: boolean;
  id: string;
  check: string;
  out: string;
  policy: SecretPolicy;
  timezone?: string;
}

export interface SessionAnswer { id: string; connector: string; op: string; args: unknown; result: unknown; observed_at: string; before_cut: boolean; world?: "exact" | "any-args" }
interface Reading { at: number; prompt: string; time: string; cwd?: string; model: { provider: string; id: string }; answers: SessionAnswer[]; read_only?: Record<string, string[]>; files?: string[]; edits?: { line: number; text: string }[] }
type ProjectCopy = Omit<NonNullable<NonNullable<MomentManifest["resume"]>["project"]>, "tar" | "more"> & { parts: Buffer[] };

const PART_LIMIT = 1536 * 1024 * 1024;
const LIMITS = { git: { bytes: 1024 ** 3, files: 50_000 }, today: { bytes: 200 * 1024 ** 2, files: 10_000 } };
const SYSTEM_EXACT = ["/", "/Users", "/home", "/root", "/var", "/private", "/private/var", "/tmp", "/private/tmp", "/opt", "/Volumes", "/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp"];
const SYSTEM_TREES = ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/var", "/private/var", "/dev", "/cores", "/proc", "/sys", "/boot"];
const TEMPORARY = ["/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp"];
const SETTINGS = [".ssh", ".gnupg", ".aws", ".azure", ".gcloud", ".config", ".docker", ".kube", ".password-store", ".pki", ".local", ".cache", ".npm", "Keychains"];
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;

async function notCopied(folder: string): Promise<string | undefined> {
  const homes = [homedir(), await realpath(homedir()).catch(() => homedir())];
  for (const root of new Set([folder, await realpath(folder)])) {
    if (homes.includes(root)) return "the session ran in the home folder";
    if (root === "/" || homes.some(home => home.startsWith(`${root}/`))) return "the session ran in a folder that contains the home folder";
    const within = (tree: string) => root === tree || root.startsWith(`${tree}/`);
    if (SYSTEM_EXACT.includes(root) || (SYSTEM_TREES.some(within) && !TEMPORARY.some(within))) return "the session ran in a system folder";
    if (root.split("/").some(part => SETTINGS.includes(part)) || homes.some(home => within(join(home, "Library")) || (dirname(root) === home && basename(root).startsWith("."))))
      return "the session ran in a login or settings folder";
  }
  return undefined;
}

async function checkRoom(bytes: number, places: readonly string[]): Promise<void> {
  const needed = bytes * 3 + 512 * 1024 ** 2;
  for (let place of places) {
    while (!(await stat(place).catch(() => undefined))) place = dirname(place);
    const disk = await statfs(place);
    if (disk.bavail * disk.bsize < needed) throw new Error(`Not enough disk space to copy the project's files: making the copy needs about ${size(needed)}, and ${place} has ${size(disk.bavail * disk.bsize)} free`);
  }
}

async function projectCopy(cwd: string | undefined, time: string, out: string): Promise<ProjectCopy | { not_copied: string } | undefined> {
  if (!cwd || !(await stat(cwd).catch(() => undefined))?.isDirectory()) return undefined;
  const git = async (args: string[], at = cwd) => (await execute("git", args, { cwd: at, encoding: "utf8" })).stdout.trim();
  const top = await git(["rev-parse", "--show-toplevel"]).catch(() => undefined);
  const commit = top && await git(["rev-list", "-1", `--before=${time}`, "HEAD"], top).catch(() => "");
  const fromGit = !!(top && commit);
  const root = fromGit ? top! : cwd;
  const refused = await notCopied(root);
  if (refused) return { not_copied: refused };
  const limit = fromGit ? LIMITS.git : LIMITS.today;
  const over = { not_copied: `the folder has more than ${limit.files.toLocaleString("en-US")} files or ${size(limit.bytes)}, so nothing was copied` };
  const left_out: string[] = [];
  let bytes = 0, count = 0;
  let blobs: { mode: string; type: string; sha: string; path: string }[] = [];
  const found: { path: string; kind: "folder" | "file" | "link" }[] = [];
  if (fromGit) {
    const listing = (await execute("git", ["ls-tree", "-r", "-l", "-z", commit!], { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 })).stdout.toString("utf8").split("\0").filter(Boolean);
    blobs = listing.map(line => { const tab = line.indexOf("\t"); const [mode, type, sha, length] = line.slice(0, tab).split(/ +/) as [string, string, string, string]; return { mode, type, sha, length: Number(length) || 0, path: line.slice(tab + 1) }; }).filter(blob => blob.type === "blob").map(({ length, ...blob }) => { bytes += length; return blob; });
    count = blobs.length;
    if (bytes > limit.bytes || count > limit.files) return over;
  } else {
    const walk = async (folder: string): Promise<boolean> => {
      for (const entry of await readdir(join(root, folder), { withFileTypes: true }).catch(() => { left_out.push(folder); return []; })) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.name.startsWith(".") || entry.name === "node_modules") { left_out.push(path); continue; }
        if (entry.isDirectory()) { found.push({ path, kind: "folder" }); if (!(await walk(path))) return false; continue; }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        found.push({ path, kind: entry.isFile() ? "file" : "link" });
        if (entry.isFile()) bytes += (await lstat(join(root, path)).catch(() => ({ size: 0 }))).size;
        if (++count > limit.files || bytes > limit.bytes) return false;
      }
      return true;
    };
    if (!(await walk(""))) return over;
  }
  await checkRoom(bytes, [tmpdir(), dirname(out)]);
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-copy-"));
  const files = join(scratch, "files");
  try {
    await mkdir(files);
    if (fromGit) {
      const write = async (blob: typeof blobs[number]): Promise<void> => {
        const content = (await execute("git", ["cat-file", "blob", blob.sha], { cwd: root, encoding: "buffer", maxBuffer: 2 ** 31 - 1 })).stdout;
        await mkdir(dirname(join(files, blob.path)), { recursive: true });
        if (blob.mode === "120000") await symlink(content.toString("utf8"), join(files, blob.path));
        else await writeFile(join(files, blob.path), content, { mode: blob.mode === "100755" ? 0o755 : 0o644 });
      };
      const queue = [...blobs];
      await Promise.all(Array.from({ length: 8 }, async () => { for (let blob = queue.shift(); blob; blob = queue.shift()) await write(blob); }));
    } else {
      for (const { path, kind } of found) {
        if (kind === "folder") await mkdir(join(files, path));
        else if (kind === "link") await symlink(await readlink(join(root, path)), join(files, path));
        else await copyFile(join(root, path), join(files, path)).catch(() => left_out.push(path));
      }
    }
    const groups: string[][] = [[]];
    let part = 0;
    const group = async (folder: string): Promise<void> => {
      for (const entry of await readdir(join(files, folder), { withFileTypes: true })) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory() && (await readdir(join(files, path))).length) { await group(path); continue; }
        const length = entry.isDirectory() ? 0 : (await lstat(join(files, path))).size;
        if (part + length > PART_LIMIT && groups.at(-1)!.length) { groups.push([]); part = 0; }
        groups.at(-1)!.push(path);
        part += length;
      }
    };
    await group("");
    const parts: Buffer[] = [];
    for (const [index, paths] of groups.entries()) {
      await writeFile(join(scratch, `list-${index}`), paths.map(path => path + "\0").join(""));
      await execute("tar", ["-cf", join(scratch, `part-${index}.tar`), "-C", files, "--no-recursion", "--null", "-T", join(scratch, `list-${index}`)]);
      parts.push(await readFile(join(scratch, `part-${index}.tar`)));
      await rm(join(scratch, `part-${index}.tar`));
    }
    const cost = { bytes: parts.reduce((sum, tar) => sum + tar.length, 0), files: count };
    return fromGit
      ? { root, source: "git", commit: commit!, taken_at: new Date(await git(["show", "-s", "--format=%cI", commit!], root)).toISOString(), left_out, ...cost, parts }
      : { root, source: "today", taken_at: new Date().toISOString(), left_out: left_out.sort(), ...cost, parts };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function markCopy(project: { root: string; tar: Buffer; taken_at: string }, policy: SecretPolicy): Promise<ProjectCopy> {
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-mark-copy-"));
  const files = join(scratch, "files");
  try {
    await mkdir(files);
    await writeFile(join(scratch, "mark.tar"), project.tar, { mode: 0o600 });
    await execute("tar", ["-xf", join(scratch, "mark.tar"), "-C", files]);
    const left_out: string[] = [];
    const strip = async (folder: string): Promise<void> => {
      for (const entry of await readdir(join(files, folder), { withFileTypes: true })) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { await strip(path); continue; }
        if (!entry.isFile()) continue;
        const { msg } = await stripSecrets({ body: await readFile(join(files, path)) }, policy);
        if (msg.secrets === "unscanned") { await rm(join(files, path)); left_out.push(path); }
        else if (msg.body) await writeFile(join(files, path), msg.body);
      }
    };
    await strip("");
    await execute("tar", ["-cf", join(scratch, "copy.tar"), "-C", files, "."]);
    return { root: project.root, source: "mark", taken_at: project.taken_at, left_out: left_out.sort(), parts: [await readFile(join(scratch, "copy.tar"))] };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function sideFiles(session: string, patterns: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("/") || pattern.split("/").includes("..")) throw new Error(`Session file pattern must stay beside the session: ${pattern}`);
    if (!pattern.endsWith("/*")) { found.add(pattern); continue; }
    const folder = pattern.slice(0, -2);
    const entries = await readdir(join(dirname(session), folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile()) found.add(`${folder}/${entry.name}`);
  }
  return [...found].sort();
}

export async function createSessionMoment(o: SessionMomentOptions): Promise<MomentManifest> {
  const resume = o.recipe.descriptor.resume;
  if (!resume) throw new Error(`The ${o.recipe.descriptor.name} recipe cannot resume sessions`);
  const lines: string[] = [];
  for (const line of (await readFile(o.session, "utf8")).split("\n")) {
    const { msg } = await stripSecrets({ body: Buffer.from(line) }, o.policy);
    if (msg.secrets === "unscanned") throw new Error("The session could not be scanned for secrets");
    lines.push(msg.body ? Buffer.from(msg.body).toString("utf8") : line);
  }
  if (o.fromBeginning === (o.at !== undefined)) throw new Error("Give the moment a line with --at, or start it --from-beginning");
  const stripped = new Map<string, Uint8Array>();
  for (const path of await sideFiles(o.session, resume.files ?? [])) {
    const { msg } = await stripSecrets({ body: await readFile(join(dirname(o.session), path)) }, o.policy);
    if (msg.secrets !== "unscanned") stripped.set(path, msg.body!);
  }
  const [command, ...args] = resume.moment;
  const where = o.fromBeginning ? ["--from-beginning"] : ["--at", String(o.at)];
  const scratch = await mkdtemp(join(tmpdir(), "phoenix-session-"));
  let stdout: string, stderr: string, code: number | null;
  try {
    for (const [path, bytes] of stripped) {
      await mkdir(dirname(join(scratch, "files", path)), { recursive: true, mode: 0o700 });
      await writeFile(join(scratch, "files", path), bytes, { mode: 0o600 });
    }
    const changes: string[] = [];
    for (const [index, change] of (o.changes ?? []).entries()) {
      const original = await readFile(change.file);
      const { msg } = await stripSecrets({ body: original }, o.policy);
      if (msg.secrets === "unscanned") throw new Error(`The answer in ${change.file} could not be scanned for secrets`);
      const file = join(scratch, String(index));
      await writeFile(file, msg.body ? Buffer.from(msg.body) : original, { mode: 0o600 });
      changes.push("--change", `${change.line}=${file}`);
    }
    const child = spawn(command!, [...args, ...where, ...changes, ...(stripped.size ? ["--files", join(scratch, "files")] : [])], { cwd: o.recipe.directory, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(lines.join("\n")));
    [stdout, stderr, code] = await Promise.all([text(child.stdout), text(child.stderr), new Promise<number | null>(done => child.once("close", done))]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  if (code !== 0) throw new Error(`The ${o.recipe.descriptor.name} recipe could not read the moment: ${stderr.trim().split("\n").at(-1) ?? code}`);
  const reading = JSON.parse(stdout) as Reading;
  for (const path of reading.files ?? []) if (!stripped.has(path)) throw new Error(`The ${o.recipe.descriptor.name} recipe named a file it was not given: ${path}`);
  for (const edit of reading.edits ?? []) lines[edit.line - 1] = edit.text;
  reading.answers.push(...o.answers ?? []);
  const session = Buffer.from(lines.join("\n"));
  const view = await readCapture(o.capture);
  let mark: TraceEvent | undefined, task = "";
  for (const run of view.runs()) {
    const atLine: TraceEvent[] = [];
    for await (const event of view.events(run)) if ((event as { source_line?: unknown }).source_line === reading.at) atLine.push(event);
    mark = atLine.find(e => e.kind === "call") ?? atLine[0];
    if (mark) { task = run.task; break; }
  }
  if (!mark) throw new Error(`The imported session has no event for line ${reading.at}`);
  const prepared = await prepareSnapshotMoment({ capture: o.capture, mark: eventId(mark), start: "mark", id: o.id, connectors: [], check: o.check, workdir: false, prompt: reading.prompt, ...(task ? { task } : {}), ...(o.timezone ? { timezone: o.timezone } : {}) });
  const taken = o.project ? await markCopy(o.project, o.policy) : await projectCopy(reading.cwd, reading.time, o.out);
  const copy = taken && "parts" in taken ? taken : undefined;
  const connectors: NonNullable<MomentManifest["connectors"]> = {};
  for (const name of new Set(reading.answers.map(a => a.connector))) connectors[name] = { surface: "mcp", routes: ["transcript"], tier: "recorded", origin: reading.answers.every(a => a.connector !== name || a.world) ? "seeded" : "captured", read_only: [...(o.readOnly?.[name] ?? []).map(op => ({ op: `tools/call:${op}`, source: "plugin" as const })), ...(reading.read_only?.[name] ?? []).filter(op => !o.readOnly?.[name]?.includes(op)).map(op => ({ op: `tools/call:${op}`, source: "annotation" as const }))], data: [{ path: "data/run.jsonl", kind: "run-evidence" }] };
  const manifest: MomentManifest = {
    ...prepared.manifest, clock: { time: reading.time, timezone: prepared.manifest.clock!.timezone }, model: { id: `${reading.model.provider}/${reading.model.id}` }, connectors,
    resume: {
      recipe: o.recipe.descriptor.name, session: "data/session.jsonl", moment: "data/session-moment.json",
      ...(reading.files?.length ? { files: "data/session-files" } : {}),
      ...(copy ? { project: { tar: "data/project.tar", ...(copy.parts.length > 1 ? { more: copy.parts.slice(1).map((_, index) => `data/project.${index + 1}.tar`) } : {}), root: copy.root, source: copy.source, ...(copy.commit ? { commit: copy.commit } : {}), taken_at: copy.taken_at, left_out: copy.left_out, ...(copy.bytes === undefined ? {} : { bytes: copy.bytes, files: copy.files }) } } : {}),
      ...(taken && "not_copied" in taken ? { files_not_copied: taken.not_copied } : {}),
      ...(o.fromBeginning ? { from_beginning: true } : {}),
      ...(reading.edits?.length ? { changed_answers: reading.edits.map(edit => edit.line) } : {}),
      ...(o.madeUp ? { made_up: true } : {}),
      ...(o.marked ? { marked: o.marked } : {}),
    },
  };
  for (const [index, part] of copy?.parts.entries() ?? []) prepared.files.set(index ? `data/project.${index}.tar` : "data/project.tar", part);
  prepared.files.set("data/session.jsonl", session);
  for (const path of reading.files ?? []) prepared.files.set(`data/session-files/${path}`, stripped.get(path)!);
  prepared.files.set("data/session-moment.json", JSON.stringify(reading) + "\n");
  await writeMomentBundle(o.out, { manifest, files: prepared.files, blobs: prepared.blobs });
  return manifest;
}
