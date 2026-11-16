# Fidelity

`fidelityReport(trace, blobs?)` computes a JSON-serializable report entirely
from one sample's ordered `TraceEvent[]`. `blobs` supplies already-read UTF-8
bodies by digest; there is no I/O or live connector access. Write the returned
object to the sample directory in the caller.

The engine emits a `meta` event with `op: fidelity.context` and JSON
`FidelityContext` in its body: moment source; start point; runtime,
clock probe and per-process clock coverage; and connectors keyed by name with
plugin tier, captured-coverage tier, origin, routes and read-only operations.
These are metadata bodies in the existing trace schema, not raw-traffic
rewrites. No plugin means a recorded ceiling. Missing context is reported and
undeclared connectors cannot grade above recorded. Unused connectors are
listed separately and never lower the grade. No called connectors means no
grade, not an invented stateful grade.

For each called connector the tier is the weakest plugin ceiling, coverage
ceiling and actual response source: emulator is stateful; recorded, overlay,
prefetch, repeat and derived are recorded; simulator and synthesized fills
are synthesized; divergence/refusal is blocked. Under-layer duplicate calls do
not grade as tool connectors, and the harness's LLM traffic is never in the
trace. Clock coverage,
including a real-clock harness, is informational and never lowers a tier.

The report counts real/recorded/derived/synthesized responses and lists derived
and synthesized answers, divergence, gaps/drops/partial messages and secret
stripping/unscanned bodies directly from the trace. Engine/source-reader facts
that aren't visible in raw messages use `meta` events with JSON bodies and
these operations:

- `fidelity.answers` for filled/repeated answers and exact call references;
- `fidelity.unverified_read_only`, `fidelity.stale`,
  `fidelity.emulator_differences`, `fidelity.format_mismatches`;
- `fidelity.local_file_effects` and `fidelity.workdir` for unrecreated shim
  effects and uncertain, ignored or unread paths;
- `fidelity.gaps` for unknown tails and source-run drops, and
  `fidelity.unattributed` for events the source reader couldn't place;
- `fidelity.discounts` for discounted verdicts and their confirmation status.

Each item retains its event, connector and JSON detail. Divergence bodies are
JSON details when present. Read-only declarations from anything but a plugin
are automatically listed as unverified. Earlier server tasks that weren't
replayed are recorded in the context. The report doesn't guess those facts
from missing data or consult a manifest outside the trace.
