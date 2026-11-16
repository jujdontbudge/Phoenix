# Ozi

This recipe reads Ozi's own provider logs and can launch a fresh capture-only Ozi home with native provider routing. It targets the installed 0.1.0 app and the 0.1.4 checkout configuration. Check `ozi --version` first. It never installs Ozi, logs in, changes billing, or edits the existing home. A running server cannot acquire new routing settings retroactively.

## After the fact: nothing in the live path

Ozi stores state in `$OZI_HOME/userdata` (normally `~/.ozi/userdata`; a checkout can use `.ozi/userdata`). Its database is `statev2.sqlite`, not a Claude or Codex session directory. Import the selected thread's own `logs/provider/events.<thread-id>.log` file, including retained rotations oldest first:

```sh
node packages/cli/src/import.ts --recipe recipes/ozi/recipe.yaml \
  --home "$PHOENIX_HOME" "$OZI_HOME/userdata/logs/provider/events.$THREAD_ID.log"
```

The reader consumes stdin exactly once; `PHOENIX_SOURCE` supplies only the filename's thread identity. It accepts Ozi's `[ISO timestamp] NTIVE|CANON|ORCH: JSON` records, retaining their JSON text as metadata rather than inventing HTTP, CLI, or MCP wire exchanges. Known native protocols include Claude SDK, Codex app-server, ACP, Pi RPC, Muse MSP, Cursor SDK and OpenCode SSE. Unknown framing/protocols, malformed bytes, and bounded summaries are reported unread. Logs have no Ozi-version header, so the framing and protocol are checked, not a fabricated version field.

Coverage lists messages and any tool arguments/results the log actually kept. It explicitly lacks LLM HTTP bodies, complete MCP exchanges/tool schemas, CLI byte streams/status, filtered deltas, deleted rotations, complete prompts/history, monotonic timings, and filesystem snapshots. A complete import means the available log parsed; it does **not** mean complete capture. A log-only Moment normally needs setup fills or a fresh in-path recording before an exact Replay is possible. Raw provider records remain metadata so the engine cannot mistake an SDK message for an LLM API response.

## Native live routes

The launcher composes with Phoenix's existing capture command. Capture never touches the provider's LLM route or login. Give the capture working directory a harness contract whose MCP endpoint is `{file: .mcp.json, format: mcpServers}`. `.mcp.json` contains only the selected external stdio servers; Phoenix makes the proxied private copy. The recipe shims `ls`, `cat`, and `date`; copy the descriptor to change that list.

For native Claude, with the normal login already available and `OZI_CAPTURE_HOME` naming a nonexistent directory whose parent exists:

```sh
node packages/cli/src/capture.ts capture --recipe recipes/ozi/recipe.yaml \
  --cwd "$TASK_DIRECTORY" --routes mcp-proxy,cli-proxy -- \
  node "$PWD/recipes/ozi/launch.mjs" --source-home "$OZI_HOME" \
  --home "$OZI_CAPTURE_HOME" --instance claudeAgent --driver claudeAgent \
  --mcp-file .mcp.json -- \
  ozi serve --no-browser --mode desktop --host 127.0.0.1 --port 3775
```

Omit `mcp-proxy` and `--mcp-file` together when there are no external stdio servers. Use an absolute script path when invoking this outside the repository root. The isolated Ozi home is retained for transcript import; it copies settings, not databases, logs, or auth files from the native home. Ozi-owned managed credentials and redacted settings backed by its secret store cannot be moved by this launcher: it refuses those instances, which use the existing home's transcript route instead.

`launch.mjs` writes the selected instance's environment, including the capture PATH, through `userdata/settings.json`. This matters because Ozi normally puts login-shell PATH entries before its inherited launch PATH. It translates the proxied `.mcp.json` into Claude's `config.launchArgs --mcp-config` or native Codex's `-c 'mcp_servers={"name"={...}}'` overlay, preserving its effective `OZI_CODEX_LAUNCH_ARGS` or configured launch arguments. For native API-key Codex use an explicitly configured `setupMode: existing` instance, `--driver codex` and its instance ID. No key is inserted or substituted. Native `homePath` and `shadowHomePath` settings are preserved.

**The injected `t3-code` server is different.** Ozi constructs its authenticated loopback `/mcp` endpoint at runtime and overrides that entry in Claude/Codex/Pi; there is no user MCP URL setting for it. This recipe refuses an external entry named `t3-code`. Its calls use transcript fallback. External HTTP/OAuth MCP also uses transcript fallback with the current generic launcher, which only overlays stdio entries. No unverified forward proxy, CA installation, or undocumented endpoint override is advertised. CLI absolute paths, shell builtins, and tools that reset PATH bypass shims. Direct vendor HTTP is not captured by these routes.

## Logins

Every driver and login keeps its native LLM route and credentials; the launcher
never changes them. Claude and existing-mode Codex instances get their external
stdio MCP servers proxied through Claude's `launchArgs --mcp-config` or Codex's
`OZI_CODEX_LAUNCH_ARGS`, plus the PATH shims. Managed Codex profiles, Pi, fx,
Muse, Grok, Cursor, Antigravity, OpenCode and ACP agents use the transcript
route; their subprocesses get the capture PATH where they honor it. Ozi's
injected `t3-code` MCP server always uses the transcript route.

## One thread per Run

Use the actual Ozi thread ID, not the long-lived server PID. Start and end a task marker around a command that **waits for that thread's task to finish**:

```sh
node recipes/ozi/task.mjs --thread "$THREAD_ID" --cwd "$TASK_DIRECTORY" -- \
  sh -c 'ozi thread "$THREAD_ID" --home "$OZI_CAPTURE_HOME" --message "$TASK" --json && ozi wait thread "$THREAD_ID" completed --home "$OZI_CAPTURE_HOME" --json --timeout 120'
```

Run this inside the capture environment so the generated `phoenix` command and capture variables are inherited, or explicitly supply `--phoenix` and `PHOENIX_CAPTURE`/`PHOENIX_HOME`. A submission-only command ends the marker too early. Markers never fail the task. The transcript reader gives every per-thread record its filename's thread ID and maps observed Claude query/result boundaries to task markers. Other provider lifecycle records remain verbatim metadata; it does not fabricate an end for a rotated or interrupted log.

Ozi's MCP wire traffic does not reliably carry its orchestration thread ID. With overlapping tasks, evidence lacking its own key remains unattributed; a marker is not permission to guess. Check that coverage before selecting a Moment.

## Replay

To replay a thread Ozi ran with pi, cut the pi session file behind that thread
with the pi recipe (see `recipes/pi/README.md`). That is the path the Captain
saw working for Ozi running pi. This recipe's own server replay from a capture
can start only at the beginning and has not been run.

## Verified coverage

The installed Ozi 0.1.0 app and Claude Code 2.1.325 completed a harmless worker using the Mac's existing subscription: `ls -1`, one external stdio MCP `read_scratch`, and the expected final answer. A Git-backed task adapter recorded the MCP proxy and CLI shim together, and 48 native-log events imported; reimport leaves the immutable segment unchanged. Twelve startup/shutdown events remain unattributed, and an MCP shutdown gap/unclosed stream means the overall capture is not complete.

Native Codex 0.169.0 accepted the generated MCP configuration, preserving existing servers, quoted/dotted server names, effective launch arguments and native home paths. The four retained Sol regressions cover MCP identity, native argument precedence, refusal of unresolved Ozi secret-store credentials, and import of the wrapped OpenCode native envelope. Run them with `node --test recipes/ozi/*.test.mjs`; the MCP-name check requires an already installed `codex`, but no login or LLM call. Only the Claude subscription path was exercised with a real model; other login-mode mappings are source-backed.
