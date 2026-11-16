# Codex

This recipe supports Codex CLI 0.169.0. It reads `$CODEX_HOME/config.toml`
(default `~/.codex/config.toml`) and imports new JSONL files under
`$CODEX_HOME/sessions`. It never edits that config, logs in, changes the selected
model/provider, or copies credentials into Phoenix config. Node 24+, Python
3.11+ (`tomllib`) and the repository's installed dependencies are required.

Use the recipe launcher, not the generic JSON-MCP launcher:

```sh
node recipes/codex/capture.ts --login-mode chatgpt --cwd /path/to/task \
  --routes mcp-proxy,cli-proxy,transcript -- exec --skip-git-repo-check 'List the files'
```

Routes are explicit. Capture never touches Codex's LLM traffic: Codex talks to
its provider exactly as configured, and its session file is the record of what
it said to its LLM. Name the actual login mode; the launcher never switches
between subscription and API billing. No TLS interception is attempted.

## Put Codex back in a moment

Codex saves every session as a file under `~/.codex/sessions/YYYY/MM/DD/`.
Phoenix can cut that file at a moment and let Codex go on from there in the box,
with a changed harness. Copy the session file first. Phoenix only reads it.

```sh
phoenix moment create --session rollout-....jsonl --recipe recipes/codex/recipe.yaml \
  --at <line> --id <id> --check check.yaml <out-dir>
```

`--at` is a line of the session file. The moment starts at the user turn that
holds that line. Codex gets everything before that turn and then the turn's
message again. Use `--from-beginning` in place of `--at` to start at the
session's first message, with its original prompt. Sessions from Codex 0.167.0 and 0.169.0 that used a ChatGPT login
are supported.

In checks, MCP tools are named `<server>.<tool>`, for example
`github.create_issue`. Shell commands are `codex-shell.exec`.

### What happens in a replay

The box runs Codex's own `codex exec fork` on the cut session. Codex keeps the
history and starts a new session from it. Codex talks to its LLM directly at
chatgpt.com. Nothing from Phoenix sits in between.

Phoenix answers the tool calls from the session's own results:

- Each MCP server of the session is replaced by `mcp-stand-in.mjs`. It offers
  the server's tools with the descriptions the session saved, and sends every
  call to Phoenix.
- Codex runs shell commands with `zsh -lc`. In the box, `zsh`, `bash` and,
  for Codex only, `sh` are `shell.mjs`, which sends the command to Phoenix
  instead of running it.

### The harness

- `AGENTS.md`: instructions, added after the session's own global
  `AGENTS.md`.
- `config.toml`: Codex settings, laid on top as a Codex profile
  (`codex exec -p`). `model` swaps the LLM. `[features] shell_tool = false`
  takes the shell away. `disabled_tools` under `[mcp_servers."<server>"]` hides
  MCP tools.
- `models.json`: Codex's LLM list (`model_catalog_json`), when the session's
  LLM needs one.

List the files you want an agent to change under `editable` in
`phoenix.harness.yaml`.

### Login

`login.mjs` copies Codex's ChatGPT login into the box for one run, without its
refresh token. It is deleted after the run and never goes into a bundle, trace
or git. The login must be valid for 15 more minutes; run `codex` once to
refresh it.

### Build the box image

```sh
docker build -f recipes/codex/resume.Dockerfile -t phoenix-codex-resume:0.169.0 recipes/codex
```

Put the image ID and the path to `recipe.yaml` in the Workbench settings.

### Limits

- A shell command the session never ran runs on the files copy only when it
  just reads files, like `pwd`, `ls` or `cat`. Anything else, like `git status`,
  gets a made-up answer, or stops the replay when no simulator is set.
- The box runs Codex 0.169.0. Its own tool descriptions and base instructions
  can differ from the ones in an older session.
- Other sites on chatgpt.com can be reached from the box.
- A user turn with images or files can't be a moment yet.
- The resumed run uses the real clock.

## Logins

Every login mode works the same way for capture, because the launcher never
touches Codex's LLM route: MCP and PATH capture and the session reader.
A failed explicitly chosen
route fails loudly; it is never silently replaced. The real proof used the Mac's existing ChatGPT login. Profiles,
CLI config/profile overrides (including attached `-c`/`-p`), `--oss`,
`--ignore-user-config` and `--ephemeral` are refused by this fresh-`exec`
launcher. Codex `-C`/`--cd` and `--worktree` are also refused: set the recipe's
`--cwd` so Codex and the snapshot use one canonical task directory. A
`.codex/config.toml` between the Git project root and that directory makes routing
ambiguous, so live MCP routing is refused; transcript-only capture and
normal Codex invocation followed by explicit import remain available. Managed
restrictions are never bypassed.

## MCP and commands

Each enabled stdio entry in `mcp_servers` is overridden with the Phoenix proxy
command and original command/argv. Its original environment, cwd, timeouts,
enabled/disabled tools and other policy settings stay in place. The recording
environment is passed explicitly because Codex filters stdio-server variables.
An explicitly configured server PATH is preserved exactly; commands inside that
server bypass the generic CLI shims rather than resolve to a different executable.
There is no extra discovery request or tool added by the recipe.

Remote HTTP servers remain at their original URLs by default. Add
`--reverse-mcp server1,server2` **only** for servers whose authorization remains
valid behind a loopback reverse route (for example, your unauthenticated local
server or a server explicitly configured to allow that route). The script starts
the generic `mcp-http-proxy` runtime and overrides only the URL, preserving its
query. Existing bearer/header settings stay Codex's own. Don't use this opt-in
for resource-bound OAuth: stored OAuth credentials may be indexed by the original
URL, and authorization discovery may change. `auth = "chatgpt"` is refused.
These servers fall back to their logged tool items; no CA or auth policy is
weakened. Plugin/dynamic servers aren't rewritten.

The descriptor's `shim` list defaults to `ls`; edit that list for the external
commands you need. The generic launcher adds their proxies to PATH. Absolute
paths, builtins, shell startup files that reset PATH, and Codex's internal tools
bypass these proxies. Shell tools must preserve the inherited PATH (for example,
`exec_command` with `login: false`). A CLI result is not a filesystem snapshot of
its side effects. Direct HTTP calls aren't intercepted by this recipe.

## After-the-fact capture

Nothing has to be in the live path:

```sh
node packages/cli/src/import.ts --recipe recipes/codex/recipe.yaml \
  --home /private/phoenix /path/to/rollout.jsonl
```

Or launch with `--routes transcript` to snapshot the task directory and import
only newly created session files after exit, with no tool proxy. Resumed
files, paginated history, disabled session logging and ephemeral runs may not
produce a new JSONL file; the launcher records a gap and exits nonzero. Import
an explicitly selected file yourself rather than sweeping someone's old logs.

The reader consumes stdin, not `PHOENIX_SOURCE`. It keeps logged response items,
call IDs, function/custom-tool inputs and outputs, base instructions, turn
context and wall times. Completed command/MCP items expose their logged
argv/exit code or server/tool/arguments/results as semantic call/result events;
the raw wrapper the LLM saw remains separate and isn't guessed into a wire
request. Other event-log duplicates remain metadata. It does **not** invent LLM
HTTP exchanges, MCP envelopes, protocol versions, raw streams, terminal controls,
timings or missing reasoning. Reconstructed
answers belong to setup and must be tagged derived/synthesized. Unknown record
types or versions are retained as payload-free unread markers; import stays
incomplete. `verbatim` names only fields supplied by the session. The importer
strips secrets and makes retries idempotent. The launcher tags its fresh exec
and imports only a new file with that tag, so concurrent unrelated sessions
aren't swept into the capture. Its `--single-run` reader argv associates those
items with the one live Run; explicit imports retain the logged session ID.

## Clock

Copy `clock-probe.ts` into a harness tree and set `clock.probe` to
`[node, clock-probe.ts]`. It starts native Codex in a private temporary home with
placeholder auth and an unreachable loopback LLM URL, prints the first native
session timestamp, then terminates and cleans up. No real LLM call or login
is needed. The default static Linux musl binary ignores libfaketime in the
exercised image, so its observed clock mode is real. Clock coverage is
informational and does not lower fidelity.

Config references: [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
