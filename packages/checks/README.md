# Checks

`evaluateCheck(check, { trace, blobs? }, { expectedStates?, custom? })`
is the runner's entry point. Inputs use `@phoenix/formats`; `trace` is one
sample attempt in store order.
`blobs` supplies already-read UTF-8 bodies by digest, so evaluators do no I/O.
`expectedStates` supplies parsed locked expected-state files, keyed by the
`equals` path. A missing or undecodable input becomes an expectation error,
not a pass. An invalid check is refused.

Actions are the agent-layer tool calls in the trace. The harness's LLM
traffic is never in the trace, so it is never an action.
MCP tools are named `connector.tool`, CLI operations `connector.op` (arguments
are the invocation object, including `argv`), and direct HTTP operations `connector.METHOD path`.
Under-layer traffic is never an action.

Argument objects match their specified fields recursively; arrays and scalar
values match exactly. `{ not: value }` negates that field's matcher. `called`
without `times` means at least once; `times` is exact. `order` requires the
listed milestones in order, permits consecutive repeats of the current
milestone, and rejects a later milestone before an earlier one or a return to
an earlier milestone. Missing milestones can still be repaired; inverted ones
cannot. `max_calls` and `not_called` likewise preserve irreversible failures
on divergence. All expectations run, even after a failure.

The engine records final state using `kind: meta`, `op: end_state`,
`connector`, and a JSON state in `body`. Final harness text is a `kind:
meta`, `op: final_text` event with the literal text in `body`. A recipe's
resume path writes it from the harness's own last reply; for a harness run
from the beginning with `run.output: stdout`, the runner writes the harness's
standard output. With neither, a `final_text` expectation has no evidence. These use
the trace's existing opaque-body mechanism and don't change the schema.

`sampleVerdict` consumes the evaluation, optional intent judgment and divergence
flag. Taint is forward from the first synthesized result. Positive existence checks can be proved by their first witness; exact
counts, absence and order read through the end. Custom checks conservatively
read the entire scope. Check errors and unresolved tainted failures are
unassessed. A clean failure is binding. `momentVerdict` retains missing and
unassessed scheduled samples, starts with the check's base count (default 2),
and asks for its tiebreak count (default 1) on assessed disagreement. Half or
more failures fails the moment. `compareBaseline` checks the strictly higher
passing share; `countsTowardPass` gates set/patch claims on confirmation.

`confirmDiscount` accepts either a result-hash-specific ledger entry read by
store, or a clean passing replay of the same candidate/check/LLM/start. A
fresh-recording confirmation must use a new locked revision. The replacement
trace must show emulator answers, or recorded/real answers, on every connector
that supplied synthesized evidence. Call matching, write-history validity and
lock/ledger authority remain the existing answer/store/runner boundaries; this
function never grants approval or writes a ledger. Callers supply validated,
locked replay artifacts and the original persisted result's hash.

## Custom TypeScript

`customCheckHost({ checksDirectory, workDirectory, image, sandbox?, timeoutMs?,
maxOutputBytes? })` returns the `custom` callback for `evaluateCheck`.
`checksDirectory` must be the lock-verified bundle's checks folder. It is
copied without symlinks; only that copy, scoped sample evidence and the host
bootstrap are mounted read-only. `workDirectory` is an existing staging folder
shared with the installed container runtime (for example the sample directory;
macOS runtimes don't necessarily share the system temp folder). No candidate
tree or bundle is mounted.
The module exports exactly one function, default or named, accepting the
JSON `CheckEvidence` and returning a boolean or `Promise<boolean>`.

The image needs Node with built-in type stripping and permissions, plus the
tools/libfaketime required by `@phoenix/sandbox`. Node's module hook limits
imports to built-ins and `/checks`; Node permissions deny process/worker/addon
creation and filesystem reads outside the mounts. The sandbox has no network
route and the host refuses every relay connection. Throws, invalid exports,
non-booleans, infrastructure interruption, time limit (10 seconds by default)
or output limit (1 MiB total) become expectation errors. Limits apply to the
check process after sandbox startup. Containers and staged files are removed
on every exit, including errors.
