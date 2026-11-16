# Pi 1.5.2

This recipe targets the installed `@earendil-works/pi-coding-agent` 1.5.2 and
session format v3. It runs `pi --mode rpc`; it does not install Pi, log in,
change providers, or copy credentials into a recipe. Check `pi --version` and
`pi auth check --provider <your-provider> --json` first. Stop if either is absent
or not ready. Never use the `--credentials` or credential-printing commands in
logs. Other Pi distributions and versions need their own verification.

## Capture with the tool proxies (optional)

You don't need a capture to replay pi: a moment can be cut from pi's own
session file (see the next section). A capture adds a record of pi's MCP and
CLI tool traffic. It never touches pi's LLM: pi talks to its LLM exactly as it
always does, and Phoenix records none of that traffic. pi's own session file is
the record of what it said to its LLM.

Use an absolute path to `run.mjs` as the command inside `phoenix capture`.
The wrapper reads the launcher's selected routes from `capture.json`. The
launcher supplies the `phoenix` executable and command shims on PATH. A minimal
capture-only harness contract, stored outside the working tree if desired, is:

```yaml
phoenix_harness: 1
name: pi
run: {command: [pi, --mode, rpc], output: stdout}
editable: ["prompts/**"]
```

MCP locations are in the descriptor's `configuration.mcp` rather than the
generic launcher's single-file `mcp` field. Do not put `mcp` in this
capture contract: the wrapper applies Pi's multi-file MCP overlay itself, so
the generic launcher must not wrap it a second time.

```sh
phoenix capture --recipe /path/to/recipes/pi/recipe.yaml \
  --contract /private/path/pi.harness.yaml \
  --routes mcp-proxy,cli-proxy -- \
  node /path/to/recipes/pi/run.mjs --mode rpc
```

The wrapper creates a private, retained agent-directory overlay. Pi reads it
through `PI_CODING_AGENT_DIR`. Existing files are linked except copied
`models.json`, `settings.json` and `mcp.json`. Only MCP entries change; the
LLM settings, provider, login and billing stay exactly as they are. Refreshed
credentials still go to Pi's original auth store through its link. Sessions stay
in the original cwd-encoded session directory (including `--continue` lookup), unless `--session-dir` or
`PI_CODING_AGENT_SESSION_DIR` specifies another directory. Original model,
settings and MCP config bytes are never edited. Overlays can contain private
config and remain outside the capture in the system temporary directory. Remove
one only after keeping any new files you need.

For built-in MCP, each stdio entry in user `mcp.json` and trusted project
`.pi/mcp.json` becomes `phoenix mcp-proxy <name> -- <original argv>`. Other entry
fields, including env, cwd, exposure and enabled state, are retained. A project
MCP config needs a private symlink working-directory overlay; existing files
still point to their originals, but **new files remain in that retained
overlay**, as `coverage.jsonl` states. Relative paths use that working directory.
Project trust is still Pi's decision; pass `--approve` only for a project you
already trust.

Session selectors (`--continue`/`-c`, `--resume`/`-r`, `--session`, and
`--session-id`) keep the original working directory instead of creating that
mirror. Pi filters continued sessions by cwd and explicit session selection
can restore the session's cwd, so a mirror would either forget the session or
bypass the project proxy. These launches leave project MCP config untouched
and report its transcript fallback in `coverage.jsonl`; global stdio servers
that project config does not replace still use the proxy. Do not switch
sessions during a mirrored launch; start a separate capture with a selector.

`pi-mcp-adapter` replaces built-in MCP when installed. Pass its explicit
`--mcp-config /path/to/config.json`; the wrapper proxies that file into a private
copy. Expand adapter imports and disable other config discovery yourself first,
or those extra servers are transcript-only. Alternatively, an intentionally
isolated run can select Pi's native implementation with
`--no-extensions -e builtin:mcp`. This changes the extension loadout, so it is
not silently added by this recipe. Extension-registered tools have no universal
file override and are covered by the transcript.

Remote MCP URLs stay untouched by default, with a coverage limitation per
entry. For a specific anonymous or fixed-header Streamable HTTP server whose
resource URL you have authorized changing, set
`PHOENIX_PI_MCP_REVERSE=server-name` (comma-separated for several). The wrapper
starts `phoenix mcp-http-proxy <name> <url>` per server, preserving its path,
query, headers and bodies without discovery probes or added calls.

Do not authorize reverse routing for resource-bound OAuth. Entries with
`oauth` or provider `auth`, SSE transport, or command/environment-expanded URLs
remain direct even if listed. Implicit OAuth servers also need transcript
capture: changing their resource URL would break token binding. Session-selector
project fallbacks above still apply. No local CA is installed, auth weakened,
or unproved `HTTPS_PROXY` path enabled. An existing authenticated stdio remote
bridge can be proxied as an ordinary command without changing its resource URL.

The recipe shims external `ls`, `cat`, and `date`. Customize `shim` for commands
the task actually uses. Pi's built-in file tools bypass PATH, as do shell
builtins and absolute executable paths. Bash may reset PATH through a user's
shell startup files: verify a shim event actually arrived instead of assuming
it did. CLI output does not recreate file writes.

## Replay by resuming the session

`phoenix moment create --session <copy of a pi session file> --recipe recipes/pi/recipe.yaml --at <line>` cuts the session before the user turn that holds that line. In the box, `resume.mjs` resumes pi from the cut with `pi --fork`. Phoenix answers every tool call.

- pi-mcp-adapter hides MCP tools behind its `mcp` tool and, after a connect, behind `mcp__<server>`. `adapter.mjs` turns each such call back into the server and tool it reaches, so a calendar call through the adapter is answered as the calendar's own call. The adapter's own questions (status, list, search, describe, connect) are answered from the session. A question the session never asked gets a made-up answer, labeled in the result.
- pi's `read`, `write`, `edit`, `ls`, `grep` and `find` run for real in the box when the session never made that call, on the copy of the project's files. pi runs in the session's folder, where the copy sits. Every other new call, `bash` included, gets a made-up answer.
- The box's clock is the moment's time. `clock.mjs` moves only the clock pi's JavaScript sees. The TLS library keeps the real clock, so the LLM's certificate still checks out for an older moment.
- The harness is `APPEND_SYSTEM.md` plus any pi extension in the harness's `extensions/` folder. Both load in the box.
- pi reaches its LLM directly, with nothing from Phoenix in between. The box may reach only the addresses of the hosts in `resume.llm_hosts`, on port 443, looked up once before pi starts. DNS and every other address are shut.
- Made-up answers need an LLM for the simulator. The Captain saw one on main 14b44fbd (the Sentry untaken-write watch, simulator on OpenCode Go). When that account is out of balance, no made-up answer can be given and the replay stops at that call.
- Known limit, by Johan's decision on 2026-11-16: another site that shares the LLM provider's addresses can be reached on port 443. Closing it would need a gate in the LLM's path, which Johan ruled out as too complicated. Don't add one.

## Mark, from the beginning, made up

Four more ways into a moment, besides `--at <line>`:

- **Mark.** While pi runs, run `phoenix mark --cwd <project> --note "<why>"` from
  any terminal, or let the agent run it through its own shell. Nothing is
  attached to pi. The mark saves the newest session for that folder and its
  line, a copy of the project's files, and what each service's read-only tools
  answer right then (with `--mcp-config` and `--plugin`). `phoenix mark
  --session <file> --at <line>` marks a past moment; then nothing is saved but
  the session. Make the moment with `phoenix moment create --mark <mark-dir>`.
  The answers saved at the mark win over the session's own for the same call.
  A replay serves the mark's copy of the project's files: three samples read a
  file from the copy as it was at the mark (seen by the Captain on main 6b2f22a5).
- **From the beginning.** `--from-beginning` starts at the session's first
  message, with its original prompt.
- **A changed answer.** `--change-answer <line>=<file>` replaces the tool answer
  on that line of the session with the file's text before the replay.
- **Made up.** `phoenix moment create --made-up <folder>` reads
  `<folder>/moment.yaml` (format `made-up`: time, LLM, tools, earlier messages,
  prompt, and the world's answers) and `<folder>/check.yaml`. compose.mjs writes
  the pi session, and Phoenix answers the made-up tools from the world.

## Logins

Every pi login works the same way, because Phoenix never changes pi's LLM
settings or login. Capture proxies only tool traffic. A replay copies the login
the session used into the box for that run only, and deletes it when the run
ends (`login.mjs`).

## RPC and after-the-fact capture

Send LF-delimited RPC records to stdin, read stdout continuously, and wait for
`agent_settled`, not just a successful `prompt` acknowledgement or `agent_end`.
Then close stdin and wait for orderly exit. A `get_state` response names
`sessionFile`. `--session-dir /private/path` makes a new proof log easy to find.
Don't use `--no-session` when a later import is required. One RPC process is
one Run; use explicit `phoenix task start/end` markers for multiple tasks.

For a run with **nothing in the live path**, run Pi normally, then:

```sh
phoenix import --recipe /path/to/recipes/pi/recipe.yaml /path/to/session.jsonl
# Source-checkout equivalent on Node 24:
node packages/cli/src/import.ts --recipe recipes/pi/recipe.yaml /path/to/session.jsonl
```

The launcher currently does not auto-run transcript readers. Import after Pi
exits, including after a live capture. `--capture <capture.json's capture id>`
and the same `--home` put that import beside live evidence; otherwise import
creates its own capture. Reimporting identical bytes is idempotent.

The reader consumes stdin, never reopens `PHOENIX_SOURCE`, and retains each raw
entry with its tree links, system sections, logged tool declarations, usage and
opaque signatures. Separate structured call/result events carry `tool_use_id`
for later reconciliation. Their connector is `pi-tools`, **not** an invented MCP
server identity or wire envelope. `verbatim` names source fields; it never
claims serialization or a synthesized timestamp was on the wire. Unknown
versions, records, roles, blocks and malformed rows produce `transcript.unread`
and make the import incomplete while retaining its valid prefix.

The transcript preserves all branches; it does not guess the active leaf or
reconstruct an LLM request from compaction/context edits. It lacks raw LLM
requests, wire tool lists/protocol versions, stream timing and unreported side
effects. Those need setup fills marked derived/synthesized. Never commit a real session,
prompt, capture, credential, or proof bundle.

References: the installed Pi docs `models-configuration.md`, `providers.md`,
`mcp.md`, `rpc.md`, `session-format.md`, and `message-types.md`; upstream
[configuration](https://pi.dev/docs/latest/models-configuration),
[sessions](https://pi.dev/docs/latest/session-format), and
[MCP](https://pi.dev/docs/latest/mcp).
