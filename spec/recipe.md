# Recipe descriptor

`recipe.yaml` says how to put one harness back in a moment, and how to run it under the optional tool proxies, without editing the person's config. It declares the harness versions and login modes it covers, the capture routes it offers for each surface per version range and login mode, where MCP servers are configured and in which format, which CLI commands to shim, an optional transcript reader with the harness versions it reads, the task-key locations for a server harness (an HTTP header, a `_meta` field or a JSON path), a sandbox image, the clock probe command (`dont_fake_monotonic` is accepted but not read: the runner always keeps the real monotonic clock), and the `copy_ignored` option. No route records the harness's LLM traffic.

`resume` says how to resume the harness's own session file: the host command that cuts the session at a line or at the beginning (`moment`), the host command that writes a box-only copy of the harness's login (`login`), the box image and the command run in it, and per LLM provider the hosts the box may reach directly (`llm_hosts`). It may also name a `locate` command for `phoenix mark`, a `compose` command that turns a made-up moment into a session file, `from_beginning_only` for a harness with no resume command, and the side `files` the session needs.

The transcript reader command runs in the recipe's directory. Its stdin is the
source file's exact bytes; `PHOENIX_SOURCE` names the original absolute path for
context only. Stdout is trace-schema JSONL with inline bodies and a `verbatim`
array on every event. Use a `meta` event with `op: transcript.coverage` and an
inline JSON body `{harness_versions: string[], carries: string[], lacks: string[]}`
to state coverage. Unknown records/versions are `meta` events with
`op: transcript.unread`; their inline JSON body names the source line/type and
reason. The importer strips secrets before storage, discards stderr, assigns the
capture and route, namespaces streams, and retains only wall time. Readers never
fill missing evidence. See packages/transcripts/README.md for failure and retry
semantics. These messages use the existing v1 trace schema; no new schema is
needed.
