import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, openSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const moment = JSON.parse(readFileSync("/phoenix/moment/moment.json", "utf8"));
const { box } = moment;
const home = "/phoenix/agent";
const patch = "/worktree/opencode.patch";
const source = "/opt/opencode/source";
const marker = box.continue ? "PHOENIX_CONTINUE_" + randomUUID() : "";
const { LD_PRELOAD: _, ...inherited } = process.env;
const env = {
  ...inherited, HOME: home,
  XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: "/opt/opencode/models.json", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", npm_config_offline: "true",
  PHOENIX_OPENCODE_LOADOUT: join(home, "loadout.json"), ...(marker ? { PHOENIX_OPENCODE_CONTINUE: marker } : {}),
};
for (const dir of ["data/opencode", "config/opencode/plugins", "cache", "state"]) mkdirSync(join(home, dir), { recursive: true });
renameSync(join(home, "auth.json"), join(home, "data/opencode/auth.json"));
copyFileSync("/phoenix/recipe/stand-in.mjs", join(home, "config/opencode/plugins/phoenix-stand-in.js"));
copyFileSync("/phoenix/moment/loadout.json", join(home, "loadout.json"));

const cwd = box.directory;
mkdirSync(cwd, { recursive: true });
const copy = (from, to) => {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const path = join(from, entry.name);
    if (path === patch) continue;
    if (entry.isDirectory()) { mkdirSync(join(to, entry.name), { recursive: true }); copy(path, join(to, entry.name)); }
    else writeFileSync(join(to, entry.name), readFileSync(path));
  }
};
copy("/worktree", cwd);
const git = (...args) => spawnSync("git", args, { cwd, stdio: "ignore" });
git("init", "-q"); git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", "harness");

let opencode = ["opencode"];
const patches = [...(process.env.PHOENIX_PROJECT ? [["stand-in.patch", "/phoenix/recipe/stand-in.patch"]] : []), ...(existsSync(patch) ? [["opencode.patch", patch]] : [])];
for (const [name, file] of patches) {
  const applied = spawnSync("git", ["apply", file], { cwd: source, encoding: "utf8" });
  if (applied.status !== 0) { process.stderr.write(name + " does not apply to OpenCode 1.19.5: " + applied.stderr); process.exit(1); }
  opencode = ["bun", "run", "--conditions=browser", join(source, "packages/opencode/src/index.ts")];
}
if (process.env.PHOENIX_PROJECT) writeFileSync(join(home, "config/opencode/opencode.json"), JSON.stringify({ permission: { external_directory: "allow" } }));
const run = (args, options = {}) => spawnSync(opencode[0], [...opencode.slice(1), ...args], { cwd, env, encoding: "utf8", maxBuffer: 1 << 30, ...options });

const lines = readFileSync("/phoenix/moment/cut.jsonl", "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
for (const message of lines.slice(1)) for (const part of message.parts ?? []) {
  if (part.state?.time?.compacted > box.cut_time) delete part.state.time.compacted;
}
writeFileSync(join(home, "cut.json"), JSON.stringify({ info: lines[0].info, messages: lines.slice(1) }));
const imported = run(["import", join(home, "cut.json")]);
if (imported.status !== 0) { process.stderr.write(imported.stdout + imported.stderr); process.exit(1); }

let configured;
try { configured = JSON.parse(readFileSync(join(cwd, "opencode.json"), "utf8")).model; } catch {}
const model = configured ?? moment.model.provider + "/" + moment.model.id;
const prompt = marker || moment.prompt;
const args = ["run", "--session", box.session, "--model", model, "--agent", box.agent, ...(box.variant && !configured ? ["--variant", box.variant] : []), "--format", "json", "--", ...prompt.split(" ")];
const log = openSync("/phoenix/out/opencode.log", "w");
const child = spawn(opencode[0], [...opencode.slice(1), "--print-logs", "--log-level", "WARN", ...args], { cwd, env, stdio: ["ignore", log, log] });
const code = await new Promise(resolve => child.once("close", code => resolve(code ?? 1)));

const dump = openSync(join(home, "export.json"), "w");
const exported = run(["export", box.session], { stdio: ["ignore", dump, "pipe"] });
closeSync(dump);
let final_text = "", session = null;
if (exported.status === 0) {
  const data = JSON.parse(readFileSync(join(home, "export.json"), "utf8"));
  writeFileSync("/phoenix/out/session.jsonl", [JSON.stringify({ opencode_session: 1, info: data.info }), ...data.messages.map(m => JSON.stringify(m))].join("\n") + "\n");
  session = "session.jsonl";
  const last = data.messages.findLast(m => m.info.role === "assistant");
  final_text = (last?.parts ?? []).filter(p => p.type === "text" && !p.synthetic).map(p => p.text).join("");
}
writeFileSync("/phoenix/out/result.json", JSON.stringify({ session, final_text, code, llm: model, opencode: opencode[0] === "bun" ? "source with opencode.patch" : "release 1.19.5" }) + "\n");
process.exitCode = code;
