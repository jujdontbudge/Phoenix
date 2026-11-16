# fx 0.0.16

This recipe covers the native `vercel-labs/fx` ACP agent, not the JSON viewer of the same name. Check `fx --version` and `fx status --json` first. It never installs fx, logs in, changes the selected provider, or edits the original settings/MCP files. Later fx versions need a separate compatibility check.

## Put fx back in a moment

This works on any saved fx session, with nothing from Phoenix attached when it was recorded. Phoenix copies the session, cuts it just before a user turn, and resumes fx from the cut inside the sealed box. fx talks straight to its own LLM. Phoenix answers every tool call, from the session's own tool results first. A `read_file`, `write_file`, `edit_file`, `grep_files` or `glob_files` call the session never made runs for real in the box, on the copy of the project's files. Any other new call gets a made-up answer, labeled in the result.

Build the box image once and put its id in the Workbench settings as `image`, with this recipe as `recipe`:

```sh
docker build -f recipes/fx/resume.Dockerfile -t phoenix-fx-resume:0.0.16 recipes/fx
docker image inspect phoenix-fx-resume:0.0.16 --format '{{.Id}}'
```

The image builds fx 0.0.16 from its own source, with `stand-in.patch`. That patch sends every tool call, fx's own tools (file edits included) and MCP tools alike, to `tool.mjs`, which asks Phoenix for the answer. Nothing else in fx changes.

Make the moment from the session's `log.jsonl`. `--at` is a line in the log, and the moment starts at the turn that holds it:

```sh
phoenix moment create --session ~/.fx/sessions/v2/SESSION_ID/log.jsonl \
  --recipe recipes/fx/recipe.yaml --at LINE --id ID --check check.yaml OUT
```

Use `--from-beginning` instead of `--at LINE` to start at the session's first message, with its original prompt. fx then starts from an empty session in the box. `--change` isn't supported for fx yet.

Phoenix also copies the session's `blobs/` folder, which holds the full tool outputs, with secrets stripped. Blobs it can't scan, such as fx's binary command replays, are left out. A tool call whose full output was left out has no session answer, so a replay that makes that call again gets it answered like a new call. The original session is never changed.

The harness is a folder with `run: { resume: {} }` in its `phoenix.harness.yaml`. Three files in it change how fx acts:

- `AGENTS.md` becomes the project's `AGENTS.md` in the session's workspace. fx reads it before each turn.
- `fx.json` can name another LLM, for example `{"model": "gpt-6-luna"}`.
- `fx.patch` is a patch to fx's own source. When it is not empty, the box builds fx again with it, which takes a few minutes. Each build needs about 4 GB of memory, so start the Workbench with `--concurrency 1` when Docker has 8 GB or less. The box prints the patch's hash in `harness.stderr` once the build is done.

Limits:

- Only sessions on a Codex subscription resume. The box gets a copy of fx's Codex login for the run, with a refresh token that can't be used. The login must last 15 more minutes; run fx once to refresh it.
- The box can reach only `chatgpt.com` on port 443. Other calls fx makes, such as its update check, are refused.
- fx doesn't save its system prompt in the session. The resumed turn gets fx's own prompt and the harness's `AGENTS.md`.
- MCP servers aren't started in the box, so the resumed fx doesn't see MCP tools.
- fx runs on the real clock, even when the moment has its own time. fx checks the LLM host's TLS certificate against its clock, and an old time can fail that check.

## After the fact: no live proxy

Import a closed native session log directly:

```sh
node packages/cli/src/import.ts --recipe recipes/fx/recipe.yaml \
  --home /private/phoenix ~/.fx/sessions/v2/SESSION_ID/log.jsonl
```

The reader consumes only stdin. It checks the v1 log's sequence and CRC32C, preserves native wall times, imports known records, and reports unknown kinds, versions, truncated tails and unclosed sessions as unread. It preserves valid records before a torn UTF-8 tail. It does not reopen result-store artifacts beside the source. A native result's preview and artifact reference are not its complete output, even when fx says the stored artifact is complete. Use the read-only session export to obtain result text that fx can still load:

```sh
umask 077
node recipes/fx/export-session.mjs SESSION_ID > /private/session.json
node packages/cli/src/import.ts --recipe recipes/fx/recipe.yaml \
  --home /private/phoenix /private/session.json
```

This stamps the installed fx version on `fx session --id ID --json` output. The supported presentation execution schema is 3. Exported calls have only session-level wall time; that time is not marked verbatim for individual calls. An interrupted turn is reported as unread, and truncated outputs are partial. Every event has `verbatim`. Tool identities and argument/output values are preserved without inventing JSON-RPC envelopes, inferring connector names from underscores, or pretending these are model wire exchanges. Import subagent sessions separately. Neither route needs anything in the live path; `--no-save` leaves no session to import.

These imports create separate captures by default. Before importing into an existing live capture, its task markers must already use the native session ID; otherwise previously unkeyed wire events become unattributed. The reader does not invent that association.

## Live ACP, MCP and CLI

`capture.mjs` calls the public Phoenix capture command. Its JSON-format copy of the descriptor/contract delegates MCP configuration to `acp.mjs`, rather than the generic project's stdio-only overlay. The working directory stays unchanged. The helper requires a JSON harness contract (JSON is valid YAML), for example:

```json
{
  "phoenix_harness": 1,
  "name": "fx",
  "run": {"command": ["fx", "acp"]},
  "editable": ["prompts/**"]
}
```

Use an absolute recipe-script path when the workspace is elsewhere. For this source checkout, set `PHOENIX_COMMAND` to the JSON argv `['node', '/absolute/phoenix/packages/cli/src/capture.ts']` using **double quotes**, not shell quotes, inside the JSON. An installed Phoenix uses the default `["phoenix"]`.

```sh
node recipes/fx/capture.mjs --cwd /scratch/workspace \
  --routes mcp-proxy,cli-proxy -- \
  node /absolute/phoenix/recipes/fx/acp.mjs \
  --mcp-config /scratch/workspace/.mcp.json
```

Connect an ACP client to that command. `acp.mjs` rewrites stdio entries in the client's `session/new`, `session/load` and `session/resume` `mcpServers` arrays to `phoenix mcp-proxy`; it also reads the explicitly named fx `mcpServers` config. Client entries win name collisions. A client requesting `_meta.fx.profileMcpServers` gets its profile's stdio servers wrapped, while fx still loads the native profile for other servers. The six routing variables are passed explicitly because fx filters inherited MCP subprocess variables. Project servers not explicitly supplied still follow fx's normal project trust/configuration; they are not claimed as captured. Passing `--mcp-config` is an explicit admission of those entries, not an automatic approval of arbitrary projects.

`PHOENIX_FX_HTTP_STDIO=1` opts explicitly supplied Streamable HTTP servers with **no authentication or static headers/tokens** into the HTTP-to-stdio bridge and MCP proxy. Configure headers and `bearer_token_env` in the fx config; values stay in the child environment, never command arguments. The bridge supports JSON/SSE responses, negotiated legacy session headers, concurrent calls, server notifications on GET, and session DELETE. It records the JSON-RPC bytes delivered to fx after transport translation, not original HTTP headers or SSE timing. It never follows redirects with credentials. Do not use it for a remote OAuth server: leave that server on its original native fx configuration so the existing login authority is preserved, and use the transcript fallback. Legacy SSE servers are unsupported by this fx release itself. Do not opt an OAuth profile into a different endpoint or credential scope.

The selected CLI route adds `ls`, `cat` and `date` through PATH. Absolute commands, shell builtins, a shell startup that replaces PATH, and fx's fixed-path read-only command optimization bypass it. Native filesystem tools and direct/provider-native APIs also need the transcript fallback. A bare `ls` can use that optimization; a real shell invocation that retains PATH can reach the shim. CLI recording captures output/exit, not filesystem side effects. Inspect actual segments, not just configured routes.

## Logins

Capture never touches fx's LLM route or login, for any login mode: fx talks to
its provider exactly as configured, and its session log is the record of what
it said to its LLM. Only the installed Codex subscription was available for a
real proof.

## Replay and fidelity

Build `Dockerfile` on top of a prepared Phoenix sandbox image and resolve the resulting image to its digest before giving it to runner. It includes the checksum-verified Linux fx release, not the Mac binary, credentials, sessions or a model account. `recipe.yaml`'s image name is a build target, not a mutable image passed to runner.

Wire MCP/CLI evidence can replay those connectors. The current generic runner rewrites only `mcpServers` JSON configurations, so use that explicit config format when recording a run you want to replay from a capture. Live capture also accepts fx's canonical `mcp` command arrays, but the runner cannot directly rewrite that native format; it reports a setup failure rather than silently changing the evidence.

Made-up answers need an LLM for the simulator. None was seen in an fx replay. When the simulator's account is out of balance, no made-up answer can be given and the replay stops at that call.

Session evidence alone cannot supply missing provider requests, a complete system prompt, tool definitions, MCP envelopes or CLI frame bytes. Setup must explicitly derive/fill missing evidence, with its provenance. Keep the fidelity report with the coverage report. Static fx clock coverage is real/unknown even when the Node probe is virtual; the recipe does not claim full clock virtualization.

References: [fx v0.0.16 source](https://github.com/vercel-labs/fx/tree/v0.0.16), especially `src/core/shared/profile_paths.zig`, `src/acp/sessions.zig`, `src/core/session_manager/schema.zig` and `src/core/output/output_contracts.zig`. Current online docs can describe newer fx releases; this recipe's version boundary is intentional.
