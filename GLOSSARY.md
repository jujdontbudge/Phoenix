# Phoenix

Phoenix takes a harness back to a moment of a run it already made, using the harness's own saved session, so the harness can be edited and replayed there until it does the right thing.

## Language

**Run**:
One execution of a harness on a task, either live against real systems or synthetic against a made-up world.
_Avoid_: Trajectory, episode

**Session file**:
The file a harness saves for a run on its own, with every message, tool call and tool result. It is the record a replay is built from; Phoenix only reads a copy of it.
_Avoid_: Recording, trace, transcript (when this file is meant)

**Record**:
To save what happened in a run so a moment of it can be replayed later. A harness records by saving its own session file; Phoenix adds nothing live to make that happen.
_Avoid_: Capture (when the session file is meant)

**LLM**:
The language model a harness talks to while it runs. Phoenix never sits between a harness and its LLM.
_Avoid_: Model

**Moment**:
A point in a run that a replay is built around, picked from the session file or saved with a mark. Under `phoenix capture` the agent can also flag one, which replays from the beginning only.
_Avoid_: Snapshot, checkpoint, case

**Mark**:
A saved world at a moment, taken while the harness runs or afterward: the session file and its line, a copy of the project's files, and, when the mark is given the services' MCP config and plugins, what each service's read-only tools answered right then.
_Avoid_: Checkpoint, bookmark

**Replay**:
A re-run of a moment in the sandbox: the harness resumes its own session from the moment's cut, or starts from the beginning of the run with the original prompt.
_Avoid_: Rerun, simulation

**Harness**:
Anything that runs an agent on a task and reads its tools and LLM from config, official or self-made.
_Avoid_: Agent, framework, app

**Tool**:
Anything an agent can act through: an MCP server, a CLI command, or a direct API call.
_Avoid_: Connector (when the transport is meant), integration

**Capture**:
Recording, on our side of the boundary, the tool traffic that passes through Phoenix's MCP or CLI proxy during a run. It is optional, and it never includes the harness's LLM traffic.
_Avoid_: Snapshot, export, dump

**Capture recipe**:
A ready-made, installable way to read a particular harness's session file, resume it in a replay, and optionally capture its tools.
_Avoid_: Plugin (when only capture is meant), integration

**Working copy**:
A stand-in for one real service that answers a replay's calls the way the real service would and takes its writes, so the real service is never touched.
_Avoid_: Mock, fake

**Files copy**:
A copy of the project's files at the moment, in which a replay's new file reads and writes run for real.
_Avoid_: Workspace, checkout

**Made-up answer**:
A tool answer the simulator LLM writes for a call nothing else can answer, labeled as made up in the result.
_Avoid_: Fake answer, guess

**Improver**:
Whoever edits the harness and replays the moment until it passes: usually an outside agent the person connects, or the person themselves by hand.
_Avoid_: Optimizer, fixer, evolve agent

**Success check**:
The written definition of the right thing at a moment, fixed before the loop starts: either a deterministic expectation (a tool call, an action, or an end state) or a plain-language statement of intended behavior.
_Avoid_: Rubric, eval, test, expected output

**Snapshot**:
The real state behind a moment from a live run.
_Avoid_: Export, dump, backup

**Scenario**:
A staged or seeded world for a situation that never happened live, which yields moments that replay the same way.
_Avoid_: Fixture, mock world, test environment

**Workbench**:
The workspace and tools the Improver uses to read a moment, edit the harness, replay, and check.
_Avoid_: Sandbox app, studio

**Correction**:
A person's fix or rejection of what the agent did at a moment, which is the default starting point for its success check.
_Avoid_: Feedback, label, annotation
