# Phoenix: Spec

Status: November 16, 2026, written from the grill, updated with answers to the first architecture's questions, and updated for ADR 0007: a replay resumes the harness's own saved session, and nothing from Phoenix sits between a harness and its LLM.

## 1. Goal

When an agent makes a mistake in a live run today, there is no way to go back to that exact moment and try again. The services it touched have moved on, most vendors offer no on-demand snapshot, and any fix ends up being tested against a different world than the one where the mistake happened.

Phoenix is an open-source system that takes a harness back to a moment of a run it already made. The harness's own saved session file is the record. Phoenix cuts a copy of it at that moment, the harness resumes from there in a sealed box with the same prompt, tools and history, and Phoenix answers its tool calls. Then an outside agent, or the person by hand, edits the harness and replays that moment until the agent does the right thing. The fixed harness is the same one that goes live.

It is for anyone who builds or runs agents: people using an official harness such as Claude Code, Codex, pi or fx, and people with a harness they built themselves. It works with any tool an agent can use, whether that is an MCP server, a CLI command or a direct API call. That covers calendar, email, Notion, Slack, databases, research tools, iMessage and more.

What makes it different: Palantir's Ontology Snapshots and AIP Evolve do this for data that already sits in one ontology Palantir controls. Phoenix takes on the harder version, where the data is spread across connectors the builder does not control.

## 2. Principles

- **Record on our side of the boundary.** Most services can't snapshot on demand (Notion has no snapshot call; Slack and Gmail have only slow admin exports), so Phoenix never depends on them. Everything the agent saw is already in the harness's own session file, and Phoenix's optional tool proxies and `phoenix mark` can save more as it happens, so when a moment goes wrong its record already exists.
- **Any tool, not just MCP.** Agents act through MCP servers, CLI commands and direct API calls. Capturing only one of these would let the others slip past both the replay and the safety guarantee.
- **Depend only on standards at the edges.** Nobody has to change someone else's code. Each person keeps their own server, connector and harness, and points it at Phoenix.
- **Not tied to any one harness.** Nothing in Phoenix assumes Ozi or any other particular harness. Every part can be swapped, rebuilt or studied, however people want to use it.
- **Safe by default.** Nothing in a replay can write to a real system, and Phoenix never deploys anything to production.
- **Honest about fidelity.** Every run says what was real, recorded, derived or invented, so a pass can be trusted or discounted. Phoenix never invents data silently.
- **The right thing is written down first.** A moment's success check is fixed and approved before anyone tries to pass it, and whoever is trying to pass it can never edit it.
- **Open formats.** Traces, moment manifests and the plugin interface are plain, documented, versioned files that work in any language. Captured data is kept separate from code, so a moment can be shared without sharing the tool.

## 3. What it does

### Capture
- Capture is optional. When a harness runs under `phoenix capture`, the proxies save every tool call, every response and its timing, without changing what the agent does. They never touch the harness's LLM traffic. Capture never slows, blocks or stops the agent. If saving falls behind or fails, the capture gets a clearly marked gap and the agent carries on.
- Out of the box Phoenix ships an optional **MCP proxy**, an optional **CLI proxy**, and a set of **capture recipes**. A capture recipe is a ready-made way to capture a particular agent or tool surface, run alongside the agent, so that setting up replay is easy. The defaults are broad enough that a typical setup needs no custom code.
- Capture routes are the person's choice, and there are many: the harness's own thread transcripts or session logs read after the fact, with no proxy in the path; the CLI proxy; the MCP proxy; `phoenix mark`, which saves the files and each service's answers at a moment; and more. Phoenix never records the harness's LLM traffic. Whatever a chosen route didn't capture, an agent in the setup step fills in, and each filled-in answer is tagged with its fidelity (derived or synthesized).
- Capture recipes aim to cover any login mode of any harness, including Ozi, pi and fx.
- By default one launch of a harness is one run. A long-lived server harness marks where each task starts and ends, using its session or thread id or a marker call.
- The harness's working directory is captured at the start of a run. Files git ignores are listed by default, not copied. Copying them is an opt-in, set per capture or per moment.
- Running read-only tools at capture time, over the objects the agent saw, is opt-in per connector.
- The harness's own session file keeps what its LLM saw from every tool, including tools nobody proxied.
- The MCP proxy is an ordinary MCP proxy on the wire. Official, community and self-built servers all work the same way, over local (stdio) and remote (Streamable HTTP) transports. A person points their harness at the proxy and leaves their server unchanged. The negotiated MCP protocol version is recorded, since servers differ by revision.
- Where a server calls a vendor API, Phoenix can answer that HTTP traffic from the recording or an emulator, so the real server code still runs.
- Privacy: private local captures keep the raw data exactly as recorded, except that passwords, tokens and auth headers are always stripped. Personal data is scrubbed only when a moment is packed to share, and media that can't be scanned is withheld at packing. Raw captures are never published.

### Moments
- A **moment** is a marked point in a run, which can be live or entirely synthetic. A person or another agent picks it afterward from the session file, which keeps every step, or saves it with `phoenix mark` while the harness runs. Under `phoenix capture` the agent can flag one itself, but that moment replays from the beginning only.
- The mistake can be anything at any step, from the very first action onward. A replay starts at the moment's cut in the harness's own session file, with everything before the cut given back to the harness as its own history, or at the beginning of the run with the original prompt. A moment made from a Phoenix capture alone, with no session file to resume, replays from the beginning only.
- A moment comes from either a **Snapshot**, the captured real state behind a live run, or a **Scenario**, a staged or seeded world for a situation that never happened live (a calendar with chosen events, a Slack workspace with chosen threads). Both kinds replay the same way.
- A moment is saved as a **moment manifest**: a plain text file that can sit in git next to the harness. It holds the connector snapshots or logs, the clock time, the working directory, prompt, LLM, harness version, recorded tool lists, MCP protocol version, and the success check.

### Success check
- Every moment has a success check that says what the right thing is. It is written down before the loop starts.
- It can be a **deterministic expectation**: a tool was called or not called with matching arguments, tools were called in a given order, the number of calls stayed under a cap, the end state of a stateful fake equals the expected state, or the final text contains or matches something. It can also be a custom check written in TypeScript. Or it can be a **plain-language statement of intent**, such as "move only the 3pm, notify attendees, leave recurring events alone."
- Following Palantir, a person's **correction** is the default starting point: when someone fixes or rejects what the agent did, live or afterward, that becomes the expected behavior. A correction can be marked as a one-off so it never becomes a check. For now, corrections are entered through Phoenix's CLI.
- A setup step researches the moment by reading the trace, the harness and any docs, then drafts the check, and the person approves it before it is locked. For seeded Scenarios where nobody is around to approve, the check can be locked without approval as an opt-in, set per moment.
- Phoenix runs deterministic checks itself, and their result is binding. Plain-language intent is judged by the Improver.
- LLM output varies, so each check runs on several samples. By default the setup step proposes 2, plus a 3rd when the first two disagree, and the number can be changed per moment. A moment fails when half or more of its samples fail. A pass means the harness did better than the baseline on the same LLM and the same moment.
- A pass that rests on synthesized answers is a **discounted** pass. It counts toward neither the moment-set rule nor a patch until it is confirmed, either by a stateful fake, by a fresh real recording, or by the person accepting the pass.

### The Workbench and the Improver
- The **Workbench** is Phoenix's internal sandbox. Inside it, the prompt, LLM, tools and connectors match the original run, but every connector answers from the recording or a working copy, never from the real service. Changes made live after the moment never affect a replay.
- The **Improver** is whoever fixes the harness. Usually it is an outside agent the person already uses and connects to the Workbench, such as their own coding agent, with whatever LLM and provider they choose. It can also be the person themselves, by hand. Phoenix does not ship an improver of its own.
- The Improver reads what happened, edits the harness (prompts, tools, LLM, config), replays the moment, and repeats until it passes. It also decides whether plain-language intent was met.
- It can only edit the files the harness declares as editable. Everything else is read-only, including the success check.
- When a set of moments exists, a change only counts as a pass if no moment that passed before now fails. That way a fix for one scenario can't break another.

### How a replay answers a tool call
In order:
1. With an answer saved at a mark or written for a made-up moment, if the call matches one.
2. With the recorded response, if the call matches one in the log.
3. From an **overlay**: writes made during the replay are applied on top of the recorded data, and answers can be derived from other recordings. For example, a single-event lookup can be answered from an earlier list of events.
4. From a **stateful emulator** seeded from the snapshot, for connectors that have one.
5. From read-only tools that were run in advance, at capture time, over the objects the agent saw.
6. From a **simulator LLM** that writes a response in the tool's real format. The response is checked against the tool's schema, saved so repeat calls match, and tagged as synthesized. Writes are no-ops. Synthesized answers are kept out of the pass/fail decision where possible.
7. If none of these applies, the run stops and reports a **divergence**. It never invents data silently.

When a replay resumes the harness's own session, a call the session never made is answered in this order. A file read or write runs for real inside the box, on a copy of the project's files. So does a shell command that only reads files: cat, ls, head, tail, wc, grep, rg, find, stat, pwd, sed -n and a few like them, alone or piped into each other, with every path inside the copy. Anything else, like git, a test runner, a package manager, the network or a redirect into a file, never runs on the copy. The copy comes from git at the moment's time when the folder is in git, and from the folder as it is today otherwise; the result says which. Phoenix never copies the home folder, a folder that contains it, a login or settings folder, or a system folder. A folder outside git is copied only up to 10,000 files and 200 MB, and without dot-files, dot-folders such as .ssh, or node_modules. A copy from git is capped at 50,000 files and 1 GB. Over a cap, nothing is copied and the moment says why; new file calls then get the next answer. Phoenix checks that the disk has room before it copies, and the moment says how many files and bytes the copy holds. A service with a working copy, like the calendar, answers from the copy: first the copy Phoenix keeps of what the session already saw, then the plugin's `serve` copy. Anything else gets a made-up answer from the simulator LLM. The result counts the answers from the session, from the files copy, from a working copy and made up, and says when a pass or fail leaned on a made-up answer. The real project folder is never mounted in the box.

The most faithful setup runs the real MCP server and redirects only the API underneath it to the replay layer or an emulator. That way tool names, defaults, formatting and error text match production exactly, which is what lets a fix carry over to live. Vendor-hosted MCP servers can't be redirected, so they stay at recorded fidelity.

A virtual clock makes "now" match the captured moment, both for the harness and for the connector fakes.

Replays run in containers only, and Phoenix starts no hypervisor of its own. Container runtimes that run their own Linux VM, such as Docker Desktop and Podman on macOS, are fine. The clock is faked inside the container. A harness whose clock can't be faked, such as a statically linked binary, a Go program or Codex's default Linux build, still replays, on the real clock, and its fidelity grade is unchanged.

### Fidelity
- Every connector falls into a fidelity tier: **stateful** (a fake holds the full state and handles new calls), **recorded** (only calls seen in the original run are answered), **synthesized** (an LLM invents the answer, tagged as such), or **blocked** (can't be replayed).
- Every run carries a fidelity grade, set by its weakest connector, that shows which responses were real, recorded, derived or synthesized.
- Many MCP servers don't declare output formats (outputSchema is optional in the spec, and most popular servers return only text), so formats are inferred from recordings and what comes over the wire is checked rather than trusted.
- Replay is strongest for mistakes in the agent's own reasoning, prompts, tool descriptions, parsing and LLM choice, because those mostly involve the same calls and responses. It can't fully test a change that makes the agent look at something it never looked at, such as a new search query. Those calls get a derived or synthesized answer, or a reported divergence.

| Connector | Realistic tier | Why |
|---|---|---|
| Calendar | Stateful | Small, fully enumerable state and a well-specified API |
| Email | Stateful for data, approximate for search | Search ranking and spam classification happen on the server |
| Notion | Stateful but laborious, or recorded | Block trees, many requests, low rate limit, no snapshot call |
| Databases and warehouses | Stateful via point-in-time features | Version pinning such as Delta Lake time travel; size is the cost |
| Research tools | Recorded | The state is the live web plus a hidden ranking |
| iMessage | Recorded | No official API; sending is closed |
| Banking | Recorded reads, no-op writes | Real account state can't be loaded; money movement must be intercepted |

### Going live
- A fix leaves Phoenix as a patch or pull request against the harness's own repository. It contains only the files the Improver was allowed to edit, along with the replay results and the fidelity grade. The person reviews it and deploys it themselves.

### Bring your own harness, connector and parts
- **Harness.** A harness is anything that can run a task and read its endpoints from config. It declares three things: how to run it, where its MCP servers and LLM are configured, and which files the Improver may edit.
- **Connector plugins.** These are small, separately installed packages with a short interface: capture, serve, and a declared fidelity tier, including which tools are read-only. A connector with no plugin still works through generic record and replay. A test kit lets people add connectors and check their fidelity themselves.
- **Swappable parts.** The Improver, the simulator LLM and the LLM provider can all be replaced. Plugins live outside the core, and the core works with none installed.
- **Reference harness.** Phoenix ships a small harness of its own, written from scratch in TypeScript with one LLM and a few MCP and CLI tools. It serves as the example and as the proof that the harness contract works without anyone else's code.
- **Works with real harnesses.** Phoenix works with Claude Code, Codex, pi, fx, Ozi, and any harness someone builds themselves, including long-lived server harnesses that handle many tasks in one process. Phoenix never sits between a harness and its LLM. A harness needs a session file Phoenix can cut and resume; one with no resume command replays from the beginning.

## 4. Scenarios

1. **Fix a live failure.** An agent using a calendar MCP moves events around and gets it wrong. The agent flags the moment, or someone marks it later. The person writes a correction ("it should only have moved the 3pm"), and the setup step turns it into a check that they approve. They connect their coding agent to the Workbench. It replays the moment against the captured calendar state, edits the harness's tool description and prompt, and replays again until the check passes and the other saved moments still pass. Phoenix produces a patch, and the person deploys the improved harness live.
2. **Staging that was never live.** Someone builds a Scenario, such as a calendar with chosen events or a Slack workspace with chosen threads, and runs the same improvement loop on it. The moment doesn't have to come from a capture.
3. **Regression sets.** A team keeps a collection of moments and runs every proposed harness change against all of them, so a fix for one scenario doesn't break another.
4. **LLM or tool migration.** Someone re-runs recorded moments with a different LLM or a changed tool description to see whether behavior holds before switching live.
5. **Sharing.** Someone with a failing agent shares a moment manifest. Others reproduce and fix it in their own stack with their own harness.
6. **A brand-new harness.** Someone builds a harness from scratch, captures it with the default recipes, and improves it with Phoenix the same way as an official one.

## 5. Names

See [GLOSSARY.md](../GLOSSARY.md). The key words are **Run**, **Moment**, **Replay**, **Harness**, **Tool**, **Capture**, **Capture recipe**, **Snapshot**, **Scenario**, **Correction**, **Success check**, **Workbench** and **Improver**.

## 6. Stack

- **TypeScript core, run with npx.** The official MCP SDK is most mature in TypeScript, and most agent CLIs already launch Node tools. Python and a single Go or Rust binary were considered.
- **Language-neutral boundaries.** The trace format, moment manifest and plugin interface are plain files, so capture recipes and plugins can be written in any language.

## 7. Drafted

Drafted: this shows intent. The architecture decides.

| Part | Role |
|---|---|
| Recording proxy (MCP and CLI) | Sits between the harness and its tools and logs every call, response and time |
| Transcript reader | Reads a harness's own thread transcripts or session logs after the fact, with nothing in the live path |
| Replay layer | Serves recorded answers, applies write overlays, derives answers, and fails loudly on a miss |
| Moment manifest | The shareable unit described in section 3 |
| Connector plugins | Optional packages: capture, serve, declared fidelity tier, read-only tools |
| Sandbox | A container whose only way out is the harness's own LLM host; every tool call goes to Phoenix |
| Virtual clock | Makes "now" match the captured moment |
| Divergence detector | Flags any call the sandbox can't answer truthfully |
| Runner | Builds and runs a moment from its manifest and records a full trace |
| Setup step | Finds the connectors used, captures state, fills in what the chosen capture routes missed (tagged derived or synthesized), picks fidelity tiers, drafts the success check, writes the manifest |
| Workbench interface | What the Improver drives: list moments, read a trace, see editable files, edit, replay, run checks, read the fidelity report. Exposed as an MCP server plus a matching CLI, so any agent can connect |

The specs for the plugin interface, the manifest and the trace format come early and are versioned, so people can build against them.

## 8. Not doing

- **No improver of Phoenix's own.** People connect the agent they already use, so Phoenix isn't tied to one LLM.
- **No deploying.** Phoenix never touches production; the person deploys the patch.
- **No separate judge agent.** The Improver judges plain-language intent, and Phoenix runs the deterministic checks. The original idea of keeping the two apart was dropped in favor of a locked success check.
- **No dependency on vendor snapshots or exports.** They are too slow or don't exist.
- **No capture only at the MCP wire.** CLI and API tools would get past it.
- **No dependency on Ozi.** Ozi is only one of the harnesses Phoenix is checked against.
- **No holding up the live agent to protect the record.** There is no flush-before-write capture mode; a failed or lagging proxy leaves a marked gap instead.
- **No hypervisor of Phoenix's own.** Replays run in containers only.
- **No reading corrections from a harness's own approve or reject prompts, for now.** Corrections come from Phoenix's CLI; reading them from the harness is later.

## 9. Open questions

- Does the first failing moment read things the original run didn't, or does it mostly reuse what it saw? That decides how far recorded replay alone gets.
- Can the existing emulators (emulate, Backlot) hold real data: recurrence rules, attendee data, ids and timestamps? They implement only part of each API, are new, and are built for synthetic seed data.
- Is each emulator's license compatible with an open-source release? Backlot shows MIT on PyPI; emulate hasn't been checked.

## 10. Notes from the grill

- **Inspiration.** Palantir's "Own Your Evals" talk at DevCon 7 introduced Ontology Snapshots, which capture the exact state of the world when an agent runs so evals stay valid as data changes, and Scenarios, which stage events that haven't happened yet. AIP Evolve has agents explore and validate changes against your own graders. Palantir sources its expected behavior from operators' corrections and grades with deterministic checks, custom code, and LLM judges for open-ended output only. See [research/palantir.md](./research/palantir.md).
- **Where Johan got stuck before.** How do you replay when future runs may call tools that touch other live, moving systems? And how do you snapshot state that's spread across many systems (email, banking, Slack, Databricks) rather than sitting in one database?
- **Risks.** Overfitting to one moment, which is why moment sets matter. Simulator answers being cleaner than real APIs. Emulator coverage. Privacy of traces. Vendor-hosted MCP servers being stuck at recorded fidelity.
- **Prior art in Johan's own work.** Ozi's `evals/mcp-tool-use` already does a small version of this: it captures a real harness turn at the LLM API, builds a fake world with mocked tool results, has a cheap LLM play the shell, runs real tool handlers over scripted state, and grades samples against a baseline. Its rules carry over in spirit: name each case's source, add the case before the fix, include control cases, and keep user data out of fixtures.
- **Johan's original build order.** 1) Recording proxy and trace format. 2) Replay proxy that fails loudly on a miss. 3) Manifest and harness contract. 4) Improver loop on one real moment, with a success check and the environment set up by hand. 5) Fidelity check: replay an original run, diff every response against the recording, and explain each difference before trusting any improvement. 6) Overlay and derived answers for connectors like calendar. 7) Emulators, simulator, virtual clock and setup agent, once real misses show which ones are worth building. 8) Connector plugin interface and test kit.

## 11. Acceptance

Proposed, waiting for Johan's yes.

1. I use Ozi, which runs pi, live, with nothing from Phoenix attached. I pick a moment where I want it to act differently. It can be a mistake, or just something I want to change. From pi's own session file, Phoenix puts pi back in that moment. An outside agent changes the harness and re-runs until it acts the way I want.
2. The same works on a real saved session from pi, fx, OpenCode, Codex and Claude Code: from the beginning with the original prompt, and from a moment in the middle with a changed harness and the same context.
3. A made-up moment that never happened live runs the same loop.
4. A harness someone built for themselves replays from the beginning, even when it has no resume command. This is tested on real public harnesses, built for different purposes by proven people with credibility.
5. For a service that has a working copy (calendar first), a replay never touches the real service, and the copy answers the way the real one does.
