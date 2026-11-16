# Backend-driven listeners

`mcpStdioTap`, `mcpHttpTap`, `cliTap`, and `httpTap` take a `Backend`.
They do not start upstream processes, choose providers, record traffic, or resolve
answers. The caller supplies those behaviors through `Backend.open`, and can wrap
that backend with a tee. No tool body is parsed on the relay path. Taps carry tool traffic only; nothing here sits between a harness and its LLM.

`open` is synchronous and returns a bidirectional `Link`. `write` accepts outbound
frames; `frames` yields inbound frames until the connection ends or throws on an
upstream failure. A frame timestamp is host monotonic nanoseconds. `last` ends a
message or body, not the link. Each link has its own stream namespace. Transport
backpressure is awaited, recording is not. `abort` cancels the underlying operation
without retrying it. Backend errors must not contain raw payloads or credentials.

## Stdio

The MCP listener splits outbound chunks at newline boundaries without buffering
whole messages or validating JSON. Its nonnegative stream numbers increment per
line. Partial lines retain their number across chunks. An empty final frame means
stdin EOF. Return raw stdout on nonnegative streams, raw stderr on
`STDIO_STREAM.stderr`, and an optional encoded CLI exit control on
`STDIO_STREAM.control`. The listener returns the exit status to its caller.

## CLI

`open.meta` is a `CliInvocation`: argv boundaries, cwd, allow-listed environment,
and terminal status and size **independently for each descriptor**. The upstream
backend gives only those descriptors pseudoterminals; pipes stay pipes. The tap
enters raw input mode only for a terminal and restores it on completion.

`CLI_STREAM` names stdin, stdout, stderr, and control streams. Stdin ends with an
empty final frame. Control frames use `encodeCliControl`/`decodeCliControl` and
carry signals, per-descriptor resizes, or the final code/signal. Output streams
stay separate. The backend emits exit after draining output. `cliTap` returns
that exit immediately; `exitLikeCommand` sets the shim's status or re-raises the
signal. Call it after `cliTap` has removed its signal listeners.

## HTTP and MCP Streamable HTTP

`httpHandler` can be mounted in an existing server. `httpTap` and `mcpHttpTap`
return an unbound Node server; the caller chooses its address and port. Each
request opens one link, including standalone GET, DELETE, and request-scoped SSE.
Sessions, event IDs, authorization and cancellation messages are opaque traffic.

`open.meta` contains `transport: "http"`, the entry mode, and `request` (method,
unmodified URL, raw header pairs, HTTP version, transport scheme, and the CONNECT
authority for an intercepted tunnel). The route's optional metadata is `details`.
`HTTP_STREAM` names the request body, response head/body, and both trailer streams.
Bodies are raw byte fragments; heads and trailer header arrays use the pure wire
codecs. Emit the head before body frames and an empty final body frame even for an
empty response. A dropped upstream must throw from `frames`, not emit a final
frame: the tap then closes the client connection with its partial bytes intact.

Reverse mode accepts origin-form URLs. Forward mode accepts absolute-form URLs
and, with caller-supplied TLS certificate options, terminates CONNECT using the
person's trusted local CA. Transparent mode accepts redirected HTTP or TLS using
the same supplied TLS options. Certificate provisioning, the original destination
mapping, and routing policy belong to the caller. No credentials, CA, discovery
requests, protocol upgrades, or application error replies are invented by taps.
