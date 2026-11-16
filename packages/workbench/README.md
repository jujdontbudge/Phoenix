# Workbench

`WorkbenchApi` for an Improver (an outside agent or a person), served as an MCP server and as a CLI from one operation table (`src/operations.ts`), so the two can't drift apart. It sits on the runner. It has no operation that writes a check, a lock or a ledger entry, and it never imports `setup` or `approvals`.

## Workspaces

```sh
phoenix workbench init --name calendar --harness <harness dir> --moments <moment set dir> --settings replay-settings.json [--base <commit>]
phoenix workbench --mcp --workspace calendar          # stdio MCP server
phoenix workbench listMoments --workspace calendar    # any operation, arguments as --<name> <value> (JSON for non-strings)
```

A workspace lives at `PHOENIX_HOME/workspaces/<name>/`. A harness inside a git repository gets a detached git worktree of that repository at the base commit (`HEAD` unless `--base` names one), and the harness is its subdirectory there. A harness outside git is copied into a private git repository inside the workspace, and gets a patch file only. The harness contract is always read from the base commit, so editing it in the tree changes nothing. A contract whose editable globs match a file of the moment set is refused when the set sits inside the harness.

`replay-settings.json` is a runner `ReplayRequest` without `moment`, `base`, `candidate`, `harness`, `start` and `samples`: the image, model route (credentials as host environment references), runtime, environment, plugins and simulator. The Workbench fills in the rest.

## Candidates

The Improver edits through `editFile` (editable paths only, no symlinks, nothing outside the tree) or directly in the tree. `startReplay` collects modified, deleted and new files against the base commit, refusing the Replay with every changed path outside the editable globs, every symlink and every path that escapes the tree. Ignored files never count. The accepted changes are written as a git commit on the base commit, through a private index, and the frozen candidate directory is exported from that commit. Later edits make the next candidate and can't change one already running.

`startReplay` plans each target moment (default: the whole set) and its baseline with the runner, then runs them in detached worker processes, so a Replay survives tool-call timeouts and an MCP restart. `getReplay` reads the runner's durable journal and restarts the worker of any unfinished Replay whose process is gone.

## Results

`runChecks` reports each sample's expectations and status for the candidate and the baseline. A moment's `leaned_on_made_up` is true only when a check read evidence at or after a sample's first made-up answer (or the check's intent was judged with any made-up answer in the sample), and `made_up_answers` counts every made-up answer in the candidate's samples, so a pass that is not flagged can still carry made-up answers that came after what the check read. `judgeIntent` records the Improver's judgment of a check's intent per sample in the workspace (`judgments.json`), and `runChecks` applies it with `checks`' own verdict rules. A target moment is one whose baseline fails; the set passes when every target passes against its baseline and every other moment still meets its check without an unconfirmed discount.

`makePatch` writes `patches/<commit>/candidate.patch` (the diff of the latest Replay's candidate commit, refused if it touches a non-editable path) and `result.json` (verdicts against baseline, sample counts, check hashes and ledger entries, intent judgments, fidelity grade, each discount marked confirmed or unconfirmed, and the moments the patch can claim). With `pullRequest` it pushes `phoenix/candidate-<commit>` to the harness repository's `origin` with the person's own git credentials and opens a pull request with `gh`. A branch already on `origin` at the same commit is not pushed again, and an existing pull request for it is returned instead of a new one.
