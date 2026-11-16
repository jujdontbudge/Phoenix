# Transcript imports

`importTranscript({root, source, reader, policy, route?})` runs an installed recipe's
`transcript_reader.command` as an argv array in the recipe directory. The reader
gets the exact source bytes on stdin and its original absolute path in
`PHOENIX_SOURCE`. It must read stdin, not reopen the path: the source digest names
the bytes it was given. `readRecipe(path)` reads a validated JSON-compatible YAML
descriptor. No harness-specific reader ships in this package.

The reader writes only trace-schema JSONL on stdout. Every event must declare
`verbatim`, even if empty, and use inline bodies. Its first metadata event should
have `op: transcript.coverage` and a JSON inline body containing
`{harness_versions: string[], carries: string[], lacks: string[]}`. List the
versions actually supported and missing evidence such as wire bytes, tool lists,
protocol version, system prompt and timings. Unknown source records or versions
must produce `meta` events with `op: transcript.unread`, with source line/type and
a reason in their body. Do not include credentials in diagnostics. Reader stderr
is drained and discarded, never logged by Phoenix.

`importEvents` accepts the same output from a Readable and a caller-supplied source
digest. It validates every event, strips secrets from the assembled inline body
and event metadata, namespaces streams by reader and source digest, assigns the
target capture and route, and removes host-monotonic timestamps. The reader's
wall times and unknown fields survive. Redacted bodies above 64 KiB enter the
blob store. `secretKey(home)` provides an atomically published private HMAC key at
`PHOENIX_HOME/secret-hmac.key`; callers may instead supply their capture policy.

Malformed rows, missing coverage, unread records, input failures and child
failures make the import incomplete, with line-numbered payload-free diagnostics.
Valid events before a failure are retained. The import segment's final
`transcript.status` event is the authoritative summary; coverage.jsonl also gets
that summary. Publishing is atomic and keyed by reader plus source digest.
Re-importing identical bytes never replaces evidence, even if the original
reader failed: the original partial segment and status remain authoritative.
Fixing a reader requires a new reader identity (change its command/version).
`importTranscript` includes the command and supported versions in that identity.
One caller makes an exception: when `phoenix moment create` finds an earlier
incomplete import of the same bytes, it deletes that segment and reads once more.

This package never fills evidence, guesses missing values, reconciles duplicate
wire evidence, or writes a fidelity report. Setup calls the pure wire derivations
later; the merged store reader already marks cross-clock ordering approximate.

The CLI command modules export `runImportCommand` and `runRecordCommand` for the
CLI dispatcher. They are also directly runnable with Node 24:

```sh
node packages/cli/src/import.ts --recipe ./recipe.yaml --home /private/home log.jsonl
node packages/cli/src/record.ts --home /private/home --reader my-script < events.jsonl
```

`--recipe name` searches `./recipes/name/recipe.yaml`, then
`PHOENIX_HOME/recipes/name/recipe.yaml`. `--capture id` targets an existing capture
or creates one. Without it, import uses a stable id for recipe name and source
path, and record uses its input digest. Both commands return JSON with the
capture directory, segment, deduplication and completeness result; incomplete
imports exit 1. A stable capture id lets a changed source become another segment
without modifying earlier evidence. The script caller must provide coverage too.
