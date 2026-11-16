# Phoenix

Phoenix takes an agent harness back to a moment of a run the harness already made, so you can change the harness and see whether it now does the right thing. The harness's own saved session file is the record. Phoenix cuts a copy of that file at the moment you pick, and the real harness resumes from there inside a container (the box) that can reach only the harness's LLM. Phoenix answers the harness's tool calls, so no tool call in a replay reaches a real service. An outside agent, or you by hand, then edits your real harness files (its prompt, its config, the LLM it uses) and replays the moment until a check you approved passes. The change comes out as a patch you apply yourself.

Phoenix doesn't proxy, read or record the harness's LLM traffic. The box connects straight to the LLM host, using a copy of the harness's login that the recipe puts in for that run and that is deleted after it. For mini-swe-agent and the customer service demo, the recipe picks the LLM endpoint.

## Install

```sh
curl -fsSL https://phoenix.eilmer.si/install | sh
```

This installs the latest release for macOS or Linux (arm64 or x64) into `~/.phoenix`, with its own Node.js, and verifies the download's SHA-256 checksum. Pin a version with `curl -fsSL https://phoenix.eilmer.si/install | sh -s -- v0.1.0`. Run the same command again to upgrade, and delete `~/.phoenix` to uninstall. Replays need Docker or Podman. The optional tool proxies use git and Python 3.

## How it works

1. **Pick a moment.** Copy a session file your harness saved, and cut it at a turn: `phoenix moment create --session <copy> --recipe recipes/pi/recipe.yaml --at 8 --id ask-first --check check.yaml moments/ask-first`. Lines count from 1. `--at 8` picks the user turn that holds line 8; the cut falls just before that turn, so the harness redoes the whole turn. Use `--from-beginning` instead of `--at` to start at the session's first message with its original prompt. Or run `phoenix mark` while the harness runs: it saves the session's line, a copy of the project's files and, when you give it `--mcp-config` and a `--plugin`, what each service's read-only tools answer right then. Then make the moment with `phoenix moment create --mark <mark folder> --id <id> --check check.yaml <out>`.
2. **Write down the right thing.** The check says what the agent should do at that moment, for example "call `list_events`, never call `move_event`". Approve it once with `phoenix check approve <moment>`; after that the Workbench, and any agent using it, can't change it.
3. **Replay.** Make a workspace with `phoenix workbench init --name <workspace> --harness <dir> --moments <dir> --settings <replay-settings.json>`. The replay settings name the harness image, the recipe, the plugins and the simulator LLM. `phoenix workbench startReplay --workspace <workspace>` runs the moments in the box, each by default twice, plus a third time when one sample passes and the other fails. Each tool call is answered from, in order: answers saved at a mark or written for a made-up moment; the session's own recorded result; a service's working copy; a made-up answer from a simulator LLM, labeled as made up. A file tool call the session never made runs for real on the copy of the project's files instead of getting a made-up answer. When nothing can answer, the replay stops and says why.
4. **Change the harness until it passes.** Connect an outside agent to the Workbench's MCP server (`phoenix workbench --mcp --workspace <workspace>`), or edit the paths listed under `editable` in the harness's `phoenix.harness.yaml` yourself, and replay again. A pass counts only when it passes more samples than the unchanged harness on the same moment. `phoenix workbench makePatch --workspace <workspace>` gives you the change as a patch.

"Records" in this README means one thing: the harness saves its own session file, with nothing from Phoenix attached. Phoenix adds nothing live to make that happen; `phoenix mark` runs beside the harness and changes nothing in it. The optional MCP and CLI proxies (`phoenix capture`) can save tool traffic too; they never record the harness's LLM traffic. A moment made from such a capture alone, with no session file to resume, replays from the beginning only.

## What works, per harness

Each cell says what was seen and by whom: **Captain** (the agent that directs the build ran it on the main branch itself), **worker only** (only the agent who built it saw it) or **not seen**. The run behind each "yes" is listed under the table. "New tool call" means a call the session never made.

| Harness | Records | Replays from a moment in the middle | Replays from the beginning | What answers a new tool call | Known limits |
|---|---|---|---|---|---|
| pi | pi's own session file. `phoenix mark` works on a live pi run: Captain (R1). | Yes: Captain (R2, R3). | Yes: worker only (W1). | File tools: the files copy, Captain (R3). Calendar: Phoenix's own copy of what the session saw, Captain (R3). Sentry: the Sentry copy, Captain (R4). Anything else: a made-up answer, Captain (R5). A new shell command that only reads files: the files copy, Captain (R17). Other shell commands: see L3. | L1, L2, L3, L4 |
| Ozi running pi | The pi session file behind the Ozi thread: Captain (R6). Mark: not seen. | Yes: Captain (R6). | Not seen. | As for pi. A calendar `get_event` answered from Phoenix's copy: worker only (W2). | L1, L2, L4, L5 |
| OpenCode | OpenCode's own session database; the recipe exports a copy: Captain (R7). Mark: not seen. | Yes, on a moment where the unchanged harness made no tool calls: Captain (R7). Recorded answers then a stop on a new call: worker only (W3). | Yes, reaching a real "fails" verdict: worker only (W1). | File reads and shell commands that only read files: the files copy, Captain (R17). `git status`: a made-up answer, Captain (R17). Earlier code: worker only (W4). | L2, L6, L7 |
| fx | fx's own session log and its side files, secrets stripped: Captain (R8). Mark: not seen. | Yes: Captain (R8). | Yes, in a run where Phoenix answered no tool calls: Captain (R9). | `read_file`: the files copy, Captain (R10). `edit_file` and `write_file` in a box: not seen. A new shell command: nothing yet, the replay stops (R9). Made-up: not seen. | L2, L3, L6, L8 |
| Codex | Codex's own session file: Captain (R11). Mark: not seen. | Yes, in a run where Phoenix answered no tool calls: Captain (R11). Recorded shell answers: worker only (W5). | Yes, in a run where Phoenix answered no tool calls: Captain (R12). | Shell commands that only read files: the files copy, Captain (R17). Other shell commands: see L3 (R11, R12). A new MCP call with no simulator set stops the replay. | L2, L3, L6, L9 |
| Claude Code | Claude Code's own session file: Captain (R13). Mark: not seen. | Yes, where the passing answer made no tool calls: Captain (R13). One recorded answer served: worker only (W6). | Yes, on a moment with no tool calls: Captain (R14). | Gmail connector calls: the email copy, Captain (R15). A new `Bash` call that only reads files: the files copy, Captain (R17). Other `Bash` calls: a made-up answer, Captain (R17); see L3. Calendar calls through the claude.ai connector: the calendar copy, Captain (R18). File tools on the files copy: not seen. | L2, L3, L6, L10 |
| mini-swe-agent | Real runs can't be resumed: the harness has no resume command. Only made-up moments work; the recipe turns one into a small session file. | No (the harness can't resume). | Yes, both samples finished with a real verdict: Captain (R16). Fail to pass: not seen. | Its shell calls are answered from the made-up moment's world: Captain (R16). | L11 |
| OpenAI customer service agents demo | Real runs can't be resumed: the harness has no resume command. Only made-up moments work; the recipe turns one into a small session file. | No (the harness can't resume). | Yes, 2 airline tool calls answered: Captain (R16). Fail to pass: worker only (W7). | Its function tools are answered from the made-up moment's world: Captain (R16). | L11 |

**Runs cited.** Captain runs are on main at the commit named.

- R1: two marks on live pi runs; the world was saved and each replay reached a verdict (main 14e06c1d).
- R2: a staged live pi run moved a meeting without asking; the unchanged harness fails 2 of 2, the outside agent's change meets the check 2 of 2 (main 5a9f270).
- R3: pi write and pi serve moments: answers came from the session, the files copy (the copy gained the new file) and Phoenix's calendar copy (main 5cd9459c).
- R4: Sentry moment, unchanged harness fails 2 of 2, the outside agent's second candidate meets the check 2 of 2; the note and activity came from the Sentry copy (main 6b2f22a5).
- R5: Sentry untaken-write watch: `update_issue` got a made-up answer, labeled, and the result flags the calls that came after it (main 14b44fbd).
- R6: a real Ozi thread with pi, cut from its pi session: fail 2 of 2, then pass 2 of 2 (main afc0ec4).
- R7: OpenCode `crew-report` moment: fail 2 of 2, then the second candidate passes 2 of 2 (main 0477735, again on ce72d7af).
- R8: fx `ci-notice` moment: fail 2 of 2, the second candidate passes 2 of 2; the LLM reached only chatgpt.com (main 8dcc6c0e).
- R9: fx from the beginning: fail 2 of 2, then pass 2 of 2; the unchanged harness stopped at its first new shell call (main 95e741e9).
- R10: fx new reads: one sample made 4 `read_file` calls, all run on the files copy (main 95e741e9).
- R11: Codex `lamp-relay` moment: fail 2 of 2 (stopped at the first new shell call), then 2 of 2 (main 21e24283).
- R12: Codex from the beginning: fail 2 of 2 (stopped at a new `pwd`), then 2 of 2 (main 5cd9459c).
- R13: Claude Code `website` moment: fail 2 of 2 (stopped at the first new `Bash` call), then 2 of 2; the box reached only api.anthropic.com (main 83aec45a).
- R14: Claude Code from the beginning: fail 2 of 2, then 2 of 2 (main af636271).
- R15: email copy through Claude Code: the unchanged harness fails, `send_message` answered by the copy; the outside agent's candidate passes, `reply` answered by the copy (main ce72d7af, one sample per run).
- R16: harnesses with no resume: mini-swe-agent's shell call answered by Phoenix, verdict fails; the customer service demo's 2 airline calls answered, verdict incomplete (main 6b2f22a5).
- R17: new shell calls. With no simulator: Codex `pwd`, Claude Code `ls -la` and pi `ls -la` ran on the files copy, and `git status` got no answer, so the replay stopped. With a simulator: Claude Code's `ls` ran on the copy and `git status` and 2 more were made up; OpenCode (one sample) ran `ls`, `pwd && ls && cat` and a read on the copy and got a made-up `git status`. Both met the check (main 0a3ed9a2).
- R18: Claude Code through the claude.ai Calendar connector: the unchanged harness fails, and a harness with one added `CLAUDE.md` rule meets the check, with `suggest_time` answered by the calendar copy; on the code from before, that call gets no answer and the replay stops. The real calendar was unchanged (main b2e9c5b9).
- W1: from the beginning on a copy of a real pi session (the unchanged harness fails, the change passes 2 of 2) and on a real OpenCode session (the unchanged harness reaches a real "fails" verdict).
- W2: Ozi `get_event` answered from Phoenix's calendar copy (on an everyday pi setup with pi-mcp-adapter).
- W3: OpenCode `ota-push` moment: 3 or 4 calls per sample answered from the session, then a stop on a new call.
- W4: OpenCode new calls before the merge: 4 from the session, 9 from the files copy, 1 made up.
- W5: Codex replays where recorded shell answers were served from the session.
- W6: a Claude Code replay with one recorded answer served.
- W7: the customer service demo going from fail 0 of 2 to pass 2 of 2.

### Limits

- L1: pi's clock is set to the moment's time only for JavaScript's `Date`. `performance.now` and the TLS library keep the real clock.
- L2: From the box, another site that shares the LLM provider's addresses (behind the same CDN) can be reached on port 443. Closing that would mean filtering the LLM connection, and the project decided not to. Don't add a filter.
- L3: A new shell command runs on the files copy only when it just reads files (`cat`, `ls`, `grep`, `find`, `sed -n` and a few more, with every path inside the copy). Anything else, like git or a test runner, gets a made-up answer, or stops the replay when no simulator is set. fx's shell commands never run on the copy.
- L4: A pi-mcp-adapter question the session never asked (for example, describe a tool) stopped the replay when it was tried; whether a made-up answer now covers it was not seen.
- L5: Ozi runs change runtime files (caches and logs, not config) under `~/.pi/agent`.
- L6: OpenCode, fx, Codex and Claude Code run on the real clock, not the moment's time. fx can't use a faked clock: its TLS check to the LLM host fails.
- L7: An OpenCode session that used MCP or plugin tools can't be cut yet, because OpenCode doesn't save their descriptions. Neither test session ran on its own LLM: one LLM is retired, the other gave a stream error.
- L8: fx: MCP servers aren't started in the box, so a resumed fx sees no MCP tools. Blobs Phoenix can't scan for secrets are left out, and a call whose output was left out gets no session answer. `--change` isn't supported. A source change needs about 4 GB per build, so run the Workbench with `--concurrency 1` on 8 GB. Only sessions on the Codex subscription resume.
- L9: Codex: the box runs Codex 0.169.0, so its own tool descriptions and base instructions can differ from an older session's.
- L10: Claude Code pins its prompt and tool list in the session and ignores a prompt given on the command line, so the recipe writes `SYSTEM.md` into the session. A cut right after a tool result adds a "No response requested." line. The test sessions came from Claude Code hosts, not the plain terminal. From the beginning, the prompt is rebuilt from the session and host-only tools are missing. A repeat of a call from before the cut isn't answered from the recording.
- L11: The harnesses with no resume command reach only two LLM routes (OpenCode Go and a ChatGPT login). Their intent checks often go unjudged, so verdicts end incomplete.
- A working copy runs in the image its plugin settings name. When that image has no clock library at `/usr/local/lib/faketime/libfaketime.so.1`, every process in the box prints an `ld.so` warning and the copy runs on the real clock. The email and Supabase plugin images have the library. The calendar and Sentry plugins ship no image, and the OpenCode and Claude Code harness images don't have it.
- Google Calendar through the claude.ai connector: the working copy does not support a successful `respond_to_event` (accepting or declining an invitation), and answers `unsupported` in a replay. It could not be recorded from one Google account. The "not an attendee" error is answered as recorded. See [the plugin's limits](plugins/google-calendar/README.md#limits).
- Made-up answers need an account for the simulator LLM. When it is out of balance, a call nothing else can answer stops the replay.
- A replay refuses to start when the harness's login has less than 15 minutes left. The box's copy of the login is deleted after every run.
- If the LLM refuses after the login step, pi and OpenCode still report "fails" rather than "could not run".
- Answers that come after a write the working copy couldn't take are flagged only when a replay resumes a session.
- A moment made from a Phoenix capture alone replays from the beginning only, and nobody has run that path on a real harness other than Phoenix's reference harness.
- Files copy: a folder outside git is copied without dot-files and dot-folders, so pi's `.pi` folder is left out.
- Files copy: Phoenix refuses a hidden folder directly in the home folder, such as `~/.claude`, but a session started deeper inside one, such as `~/.claude/projects/x`, still has that folder copied, within the size caps and without dot-files.

## Working copies

A working copy stands in for one real service in a replay. It answers the way the real service would and takes the replay's writes, and the real service is never touched.

| Service | Ways in covered | Ways in not covered | How close the answers are | Seen |
|---|---|---|---|---|
| Sentry | The Sentry MCP server: issue details, updates, notes and activity. A write the copy can't take gets a labeled made-up answer, and later answers are flagged. | The `sentry` CLI. Deleting things (no MCP tool for it). | 13 real calls: 4 byte for byte, 3 differ only in ids or times, 6 differ by text the newer hosted server adds. | Captain (R4, R5) |
| Email (Gmail) | The Gmail connector, 31 of 31 tools, labels included. The himalaya CLI's piped input. | himalaya against real Gmail (blocked on an app password). A mark or resume made from himalaya calls. pi, which needs himalaya plus shell routing. A himalaya send that saves to "Sent", which the copy lacks. | 38 recorded answers: 12 exact, 23 differ only in values nobody can know in advance (ids, times), 3 real differences. | Captain (R15), one sample per run. Read-after-write: worker only. |
| Supabase | The Supabase MCP server 0.17.0, read-only, started the way Johan's launcher starts it: listing tables, SQL reads, logs and the other read-only tools. | A session recorded through the launcher itself. The Supabase CLI or psql through the shell. Logs for any window that isn't an exact repeat. A read-write session (never recorded). | 48 real calls: 45 byte for byte, 2 table lists in a different order (the same once sorted), 1 logs miss. 25 of 25 writes and errors match a real Postgres 17.6. | Captain: a session from a direct start of the same server (0.17.0, `--read-only`). Never, under this plan: a session recorded through Johan's launcher. |
| Google Calendar | Phoenix's own copy of the events the session saw (lists, gets and moves through the adapter). A full copy of the local Calendar MCP server, all 13 tools, through the plugin's serve copy. The nine tools of Google's hosted Calendar MCP server (the claude.ai connector), from the same copy. | A successful `respond_to_event` through the claude.ai connector. An adapter call whose answer depends on a calendar time zone the copy can't work out from Google's own answers. | Full copy, 54 real calls: 17 byte for byte, 28 differ only in times, ids or clock, 9 unsupported (8 need Google-made ids mapped, 1 is a time window the copy never saw). claude.ai connector, four sessions call by call: every call the copy answered matched, apart from ids Google makes up, links built from them, and times off by up to a second. | Phoenix's own copy: Captain (R3). Full copy: worker only. claude.ai connector: Captain (R18). |
| Files | File tools run for real on a copy of the project's files: from the git commit that was current when the session ran, or from the folder as it is today when it isn't in git. A mark's copy is served as it was at the mark. Phoenix never copies the home folder, login or settings folders, or a system folder, and caps everything else. Shell commands that only read files run there too. | Other shell commands, and any fx shell command. `edit_file`/`write_file` in an fx box and Claude Code's file tools on the copy: not seen. | Not compared with a real service: writes land in the copy, and reads show the copy. | Captain (R3, R10, R17); a mark's copy on main 6b2f22a5 |

## More

- [Spec](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Glossary](GLOSSARY.md)
- [Architecture decision records](docs/adr/), especially [0007: a replay resumes the harness's own session](docs/adr/0007-replay-resumes-the-harness-own-session.md)
- Each harness's recipe README under [recipes/](recipes/)

## Merging

Label a pull request `automerge` and it lands, squash-merged, once its checks pass.

License: MIT, see LICENSE
