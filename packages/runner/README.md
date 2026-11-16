# Runner

`Runner` resolves a locked moment and fixed trees into `plan.json`, then executes its samples in independent containers. `plan(request)` returns the content-addressed Replay id without starting samples; `replay(request)` plans and runs; `resume(id)` finishes unfinished work; `status(id)` reads the durable journal. The CLI equivalents are exported by `packages/cli/src/replay.ts`.

Supply a bundle path, base and candidate `{digest, directory}`, the validated harness contract, a digest-pinned image, the LLM id and parameters, the LLM URL, the start point, and optional bindings. `treeDigest` computes the SHA-256 of Git-compatible recursive blob listing rows, matching captures of clean harness trees. A tree directory contains the harness files, not `.git`, dependencies, or host state. Dependencies belong in the image. The captured working directory is overlaid per attempt; only editable paths come from the candidate.

The harness talks to its LLM itself; Phoenix adds nothing to its LLM requests. The runner sets the harness contract's `endpoints.model.env` variable to the LLM URL, and the box can reach only that URL's host directly. The harness's own LLM login comes from `model.env`, which maps harness environment variables to host environment variables: `env: { MODEL_API_KEY: { env: "PHOENIX_PROVIDER_KEY" } }`. The runner reads each host variable when a sample starts and sets it in the box; values are never written into the plan. `model.headers` is refused. `env` is for nonsecret harness configuration. Runtime credentials are not part of Replay identity. LLM selection and parameters are.

A moment made from a capture replays from the beginning only. Phoenix does not replay recorded LLM traffic to reach a later point. To start in the middle of a run, cut the moment from the harness's own session file (`phoenix moment create --session`); that moment runs through the recipe's resume path.

The check's default two samples run first, in parallel up to `concurrency`. Only assessed disagreement schedules its tiebreak. Scheduling is journaled before execution, and an unassessed sample is never removed. Base-tree plans are reused for baseline comparison; a passing baseline is reported as a failure that did not reproduce, not as an improvement.

Each sample keeps every attempt under `replays/<hash>/samples/<sample>/<attempt>/`, with its capture-format trace, clock report, assessment, fidelity report, and outcome. An interrupted attempt is kept, and `resume(id)` starts a new attempt from the start point. Completed samples never run again. A candidate crash is an outcome, not a retry.

Plans and immutable inputs are published atomically; the journal and result use synced atomic replacements. Process ownership prevents two runners from executing one Replay concurrently. An abandoned process lock can be reclaimed on the same host. The ledger and bundle are checked again before executing an unfinished Replay.

`plugins` names caller-resolved exact versions, directories containing `phoenix-plugin.json`, and digest-pinned images. The plan freezes each descriptor and directory digest, including entity maps and volatile fields. Optional `seed` and `snapshot` paths must name locked bundle files. Each attempt starts fresh emulator containers, captures their final state, and keeps credentials out of them.

Optional `simulator` supplies a resolved `model: {id, alias?}`, an `improverModel` identifier, host-header environment references, and `config: {endpoint, dialect, maxOutputTokens, temperature?, attempts?, outputSchemas?}`. With `config.command` (and optional `config.cwd`) instead of an endpoint, the simulator runs that command as its LLM: the prompt goes in on standard input and the answer comes out on standard output. Its configuration participates in Replay identity; samples share only its write-once answer store. The simulator supports MCP tool calls, HTTP exchanges and CLI invocations. CLI synthesis validates stdout, stderr and exit status before encoding the responder's frame array; commands are never executed and answers remain tagged synthesized.

Run evidence is locked JSONL referenced by connector `data` entries with `kind: run-evidence`. Preserve its merged order. Referenced evidence and snapshot blobs live at `data/blobs/<SHA-256 hex>`. Missing or mismatched blobs are refused. Only the materialized worktree and generated shim/task files enter the workload; the bundle, recording, check, ledger and trace stay outside it. The only credential that enters is the harness's own LLM login from `model.env`.

For a server harness, the ready request uses container loopback (an explicit HTTP URL can name its port), then the runner submits exactly one task. The submit response completes that task's session; the server process is stopped afterward. The fidelity context records that earlier tasks were not rebuilt. Custom checks run in a separate check container. An intent without an outside judgment remains unassessed.

```sh
node packages/cli/src/replay.ts start --request replay.json --home /path/to/phoenix
node packages/cli/src/replay.ts status sha256:...
node packages/cli/src/replay.ts resume sha256:...
```
