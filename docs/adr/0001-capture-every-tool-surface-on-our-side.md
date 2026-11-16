# Capture every tool surface on our side of the boundary

Agents act through MCP servers, CLI commands and direct API calls, and most vendors offer no on-demand snapshot, so phoenix captures at its own boundary instead of relying on vendor exports. It ships an MCP proxy and a CLI proxy plus a set of capture recipes people run alongside their own agent, and it sets versatile defaults so that a typical setup needs no custom code. Recording only at the MCP wire was rejected because any CLI or API tool would bypass it, which breaks both replay and the no-real-writes guarantee.

Update, 2026-11-16 (ADR 0007): the proxies are optional. A replay is built from the harness's own session file, and Phoenix never records the harness's LLM traffic. What stays true is the reason above: when Phoenix does capture tools, it captures every surface, not only MCP.
