# Claude Code

This recipe targets **2.1.325**, including its JSONL session format. It uses the
installed CLI and its existing login; capture never installs, upgrades, signs
in, copies login state, sets a credential, or changes the selected provider.
Resuming a session (below) is the one place a login enters a box.
`capture.mjs` checks installation/version and `claude auth status` before capture.
Core packages have no knowledge of this harness.

## Capture

Run from a trusted working directory. Pass the MCP config files you actually
want enabled, in precedence order; each must contain `mcpServers`. For example:

```sh
node /path/to/recipes/claude-code/capture.mjs \
  --login-mode subscription \
  --mcp "$PWD/.mcp.json" -- \
  -p 'List the scratch directory' --allowedTools 'Bash(ls *)'
```

The script starts a fresh session, keeps the original cwd and config directory,
and passes a private generated config through `--mcp-config` and
`--strict-mcp-config`. Other local/user/project MCP configs are intentionally
excluded: export their desired `mcpServers` entries into input files first.
No original file is edited. With no `--mcp`, no local MCP servers are enabled.
Plugin-provided and claude.ai/cloud connectors are outside that override and
must be assessed separately. The script does not claim to capture them live.

`--claudeai-connectors` turns the person's claude.ai connectors on for this run
only, through the launcher's own `--settings`, even when their settings turn
them off (`ENABLE_CLAUDEAI_MCP_SERVERS=false`). No settings file is changed.
Claude Code drops claude.ai connectors under `--strict-mcp-config`, so with this
option the launcher leaves that flag off, and MCP servers from the person's other
scopes load as well. All of them stay direct; their calls are recorded through
the session's transcript only, and `recipe-coverage.json` says so. A replay
turns them off again in the box (`ENABLE_CLAUDEAI_MCP_SERVERS=false`) and
replaces each one with a stand-in named as Claude Code named it, for example
`claude_ai_Google_Calendar`.

The defaults are `mcp-proxy,cli-proxy,transcript`. Capture never touches
Claude Code's LLM traffic; its session log is the record of what it said to its
LLM. `--routes transcript` puts nothing in the live path. `--routes` can select any subset. `--shim ls,cat` names PATH
commands; an empty value disables shims. Shell builtins, absolute paths, shell
startup that resets PATH, and Claude's native file tools bypass those shims.
Native tool blocks still appear in session logs. CLI capture doesn't recreate
filesystem writes.

Every named stdio server runs behind `phoenix mcp-proxy`. A Streamable HTTP
server can use `--remote-reverse server-name` only when the person has established
that changing its resource URL is safe (for example, a fixed-header or anonymous
server). Its path, query, headers, bodies and protocol era are forwarded, without
discovery probes or added calls. **Do not use reverse capture for resource-bound
OAuth.** Leave that server direct and use its transcript tool blocks. SSE,
WebSocket, OAuth, and remote entries not explicitly authorized remain direct;
`recipe-coverage.json` names each fallback. Phoenix doesn't weaken authorization
or quietly start a second login. Each authorized server runs behind
`phoenix mcp-http-proxy`.

`--home` chooses the private Phoenix store; `--cwd` chooses the workspace.
`--claude` accepts a JSON argv array for an existing CLI wrapper. The default is
`["claude"]`; shell functions/aliases are not inherited by child processes.
Use an executable wrapper if it selects your account. Session/resume/config
overrides belong to this script; import existing/resumed sessions separately.

While the command dispatcher is being assembled, source checkouts can name the
two public CLI entrypoints explicitly (run this from the repository root):

```sh
node recipes/claude-code/capture.mjs --login-mode subscription \
  --phoenix "[\"node\",\"$PWD/packages/cli/src/capture.ts\"]" \
  --importer "[\"node\",\"$PWD/packages/cli/src/import.ts\"]" \
  --mcp /absolute/path/to/mcp.json -- -p 'Perform a harmless scratch task'
```

## Logins

Name the login mode that is **already active** with `--login-mode`. Capture
never sets a credential, changes a base URL or touches the LLM route, so every
mode works the same way: the MCP and CLI proxies and the transcript, subject to
managed MCP policy. The script forwards the unchanged child environment and
credential store. Only the subscription mode has been exercised with a real
account here.

## After the fact

Session logs live under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, or
the corresponding `CLAUDE_CONFIG_DIR`. Normal capture imports that new session
after the launcher closes. Import a pre-existing log with **no live capture**:

```sh
node packages/cli/src/import.ts --recipe recipes/claude-code/recipe.yaml \
  --home /private/phoenix /path/to/session.jsonl
```

The reader consumes stdin, never reopens `PHOENIX_SOURCE`. It retains source
records and messages as metadata, and emits tool-use/result blocks with their
original IDs, inputs and content. Native tool names stay distinct from CLI
invocations. The `mcp__server__tool` naming convention supplies connector/operation
labels, which aren't marked verbatim. It does **not** invent JSON-RPC envelopes,
HTTP requests, tool lists, system prompts, CLI exit codes or timings. Unknown
versions, record types, malformed rows, orphan tool results and unsupported
content blocks produce `transcript.unread`; valid earlier evidence survives and
the import is incomplete. Imports use the core's shared secret stripping and
immutable deduplication. No real session data belongs in this recipe or in git.
Rows without a source timestamp use the reader's observation time, never marked
verbatim. The session ID is metadata, not a server-task marker: importing a
single CLI session must not orphan the launch's untasked live evidence.

The raw-record metadata deliberately overlaps the live taps. Setup must select
one evidence route for each exchange; it must not count the same action twice.
Transcript-only runs need explicit derived/synthesized fills before wire replay.

## Replay from a capture

A capture made with the proxies can replay only from the beginning, through the
runner's generic path. Build `Dockerfile` on top of the sandbox image from
`packages/sandbox/images` and pin its digest. The harness contract names its
command, `endpoints.model.env`, MCP config, output and editable paths, and the
replay settings' `model.env` gives the box Claude Code's own LLM login. Nobody has
run this path with Claude Code; the resume path below is the one seen working.

The tested native CLI also needed a fresh libfaketime shared-memory handle when
started from Node: delete `FAKETIME_SHARED` from the child's environment while
keeping `LD_PRELOAD` and the clock file. Otherwise that image failed at startup
with `sem_open ... File exists`.

## Resume a saved session from a moment

This is the replay path from ADR 0007. Claude Code itself resumes the saved
session in the sealed box with `claude --resume <session> --fork-session`, and
talks straight to its LLM at `api.anthropic.com`. Phoenix only answers tool
calls.

```sh
phoenix moment create --session ~/.claude/projects/<dir>/<session>.jsonl \
  --recipe recipes/claude-code/recipe.yaml --at <line> --id <name> --check check.yaml <out>
```

`--at` is a line of the session file. Use `--from-beginning` instead to start at
the session's first message, with its original prompt. Then nothing is resumed:
Claude Code starts a new session in the box with the harness prompt and tools
the session used for its first LLM request. `moment.mjs` cuts before the user turn on
or before that line and reads, from the session file alone, what the agent had
at that point: the LLM and effort, the harness prompt, the MCP servers and tool
definitions offered, the files it had read, and every recorded tool result. The
original file is only read. Build `resume.Dockerfile` and put its digest in the
workspace settings; the harness folder says `run: { resume: {} }`.

In the box, `resume.mjs` puts the cut session where Claude Code looks for it and
starts it with the moment's prompt. Tool calls go to Phoenix this way:

- Built-in tools go through Claude Code's own hooks (`stand-in.mjs`, on
  PreToolUse and PostToolUse). Bash never runs: it becomes a `cat` of the
  answer Phoenix gives. Read, Write, Edit, Glob and Grep act on files inside
  the box only, and Claude Code then gets the recorded result.
  Other built-ins are refused with the recorded answer as the reason.
- Each MCP server of the session is replaced by `mcp.mjs`, which lists the
  tool definitions the session recorded and sends every call to Phoenix.
- A call Phoenix has no answer for stops the replay. Answering new calls is
  separate work.

What a harness change can be: `CLAUDE.md` in the harness folder (Claude Code
loads it as usual), `SYSTEM.md` to replace the harness prompt,
`APPEND_SYSTEM.md` to add to it, and `.claude/settings.json` for `model` (swap
the LLM) or `permissions.deny` (take a tool away).

Things to know:

- Claude Code 2.1.322 and later pin the harness prompt and tool list in a
  `prompt_snapshot` record and send those again on resume. They ignore
  `--system-prompt-file`. So `resume.mjs` writes `SYSTEM.md` and
  `APPEND_SYSTEM.md` into that record.
- Phoenix removes secrets from the session before cutting it. That can turn a
  tool schema property with a secret-like name (for example `page_token`) into
  a placeholder, which the LLM rejects. `resume.mjs` turns such a property
  back into an empty schema.
- Claude Code keeps the session's own LLM unless `--model` is passed, so
  `resume.mjs` always passes it.
- When the cut comes after a dangling tool result (the person wrote while the
  agent was still working), Claude Code adds "No response requested." before
  the new turn. In the original session, that message arrived mid-turn instead.
- `login.mjs` copies the existing claude.ai access token (from the macOS
  keychain or `~/.claude/.credentials.json`) into the box. The refresh token is
  left out. Phoenix deletes the box's agent folder after every run. Run `claude`
  once first if the login expires within 15 minutes.
- Sessions from Claude Code hosts (Claude Desktop, other SDK hosts) set
  `CLAUDE_CODE_ENTRYPOINT`. The box uses the same value, so the same built-in
  tools appear. The host's own MCP servers become stand-ins like any other.

Sources: [authentication](https://code.claude.com/docs/en/authentication),
[MCP configuration](https://code.claude.com/docs/en/mcp), and
[session storage](https://code.claude.com/docs/en/how-claude-code-works).
