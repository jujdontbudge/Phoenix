# Engine

`startEngine` is the replay-side server for one sample. It builds the answer index from the run's evidence, writes the sample trace as a capture directory in the live format, and hosts the taps with responders as their backends. `accept` takes a relay connection (`{ destination, stream }`, as `EngineChannel` yields them). Its destination host selects a CLI shim in `routes.cli` or an MCP stdio shim in `routes.mcp`; other connections enter the `http` listener. HTTP requests use an explicitly bound path in `routes.mcpHttp` for MCP Streamable HTTP, or a host in `routes.http` for a direct HTTP connector. For example:

```ts
routes: {
  cli: { "phoenix-date": "date" },
  mcp: { "phoenix-calendar-stdio": "calendar" },
  mcpHttp: { "/mcp/calendar": "remote-calendar" },
  http: { "calendar.example.test": "calendar-http" },
}
```

MCP HTTP serves the recorded JSON or SSE response, including the recorded protocol metadata, session headers, event IDs, standalone GET and DELETE behavior, notifications, cancellation and resumption. Request IDs in terminal JSON-RPC replies are rebound to the candidate's IDs. Stream chunks wait for the calls that preceded them in the recording, so a server-initiated request can be answered on another POST before its originating stream continues. An unseen lifecycle operation, session/cursor or server-request reply diverges. There is no protocol discovery, invented success or live tool connection.

## CLI shim contract

A CLI connection is bidirectional UTF-8 JSON Lines over the relay's byte stream. The first outbound line is a `CliInvocation` (the object `cliTap` passes as `Backend.open().meta`):

```json
{"argv":["date","+%F"],"cwd":"/candidate","env":{"LANG":"C.UTF-8"},"terminals":{"stdin":null,"stdout":null,"stderr":null}}
```

Every following line, in either direction, is `{ "stream": number, "bytes": "base64", "last": boolean }`. Outbound stream 0 is stdin (`last: true` closes it); outbound stream 3 carries an encoded CLI signal or resize control. Inbound streams 1 and 2 are stdout and stderr; inbound stream 3 carries `{ "type": "exit", "code": number|null, "signal": string|null }` as base64-encoded JSON. `last` is a frame boundary, not a command exit. The shim returns or re-raises the exit control, not TCP EOF. A `cliTap` with a byte-channel-backed `Backend` supplies descriptor detection, raw terminal handling, signals and resizes without duplicating them in the runner.

The invocation key contains the argv array, cwd, allow-listed environment and terminal descriptors. The runner must explicitly map container cwd/environment values to their recorded equivalents when materializing a recording; the responder does not discard these fields or join argv into a shell string. Recorded stdin and controls are checked in interaction order, independent of stdin chunk boundaries, before dependent output is released. No command is launched, and local file effects are not recreated.

Every tool call goes through the answer chain. The engine has no route for the harness's LLM: the harness talks to its LLM host directly, and none of that traffic passes through Phoenix. Every event, including each answer, is synced to the sample trace before the answer is sent. `stopped` resolves with the first divergence (also written to the trace) or with an interruption, and every open connection is then closed.

`VirtualClock` starts at the run's captured start time and moves with the real clock from there.
