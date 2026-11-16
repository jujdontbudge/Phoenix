# Setup

Only the manual parts of setup live here so far. Connector discovery, gap filling, operation classification, tier choice and check drafting are not built.

- `createSnapshotMoment` turns a mark in a captured run into a draft bundle. The person names the run (capture and task key), the mark, the start point (`beginning` or `mark`; a moment made from a capture replays from the beginning only, so `phoenix moment create --capture` writes `beginning`), and each connector with its surface. The run's events are copied whole and in run order to `data/run.jsonl`; each named connector is `recorded`, `captured`, with an empty read-only list. The check draft is the person's own file (`check`), or, without one, a draft whose `intent` is the run's Correction (`kind: correction`, text in `body.inline`; `op: one-off` Corrections never become checks). The run's working-directory snapshot (the one named, else the one whose `task` is the run's task key or `default` for a one-run capture, else the only one) goes to `data/workdir/run.json`; ignored files are included only when the capture copied them and the moment doesn't turn them off, and otherwise are listed without content.
- `createScenarioMoment` publishes an authored Scenario directory (`moment.yaml` with `source: scenario` and seeded connectors, `check.draft.yaml`, `data/`, `checks/`) as a bundle and locks it through `approvals.autoLock` when the manifest sets `lock: auto`.

Neither writes `check.yaml`, the lock or the ledger; `phoenix check approve` does that through `approvals`.

Snapshot bundles share every referenced event-body and included working-directory blob with the capture through hard links at `data/blobs/<hex>`. Repeated hashes share one file; excluded ignored files add no blob. Missing or corrupt blobs prevent bundle creation. The bundle remains usable after the source capture is removed, and packing copies these blobs into the shared revision rather than referring back to a private capture.
