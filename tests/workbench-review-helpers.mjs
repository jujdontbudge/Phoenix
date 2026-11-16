import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench, createWorkspace, openWorkspace } from '../packages/workbench/src/index.ts';
import { exportTree, freezeCandidate } from '../packages/workbench/src/workspace.ts';
import { Runner, treeDigest } from '../packages/runner/src/index.ts';
import { evaluateCheck, momentVerdict } from '../packages/checks/src/index.ts';
import { writeMomentBundle, digest } from '../packages/store/src/index.ts';
import { approveCheck, reviewDraft } from '../packages/approvals/src/index.ts';

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

export async function fixture(t, check, baseChange) {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-workbench-review-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const repo = join(root, 'harness'), home = join(root, 'home'), moments = join(root, 'moments');
  await mkdir(join(repo, 'prompts'), { recursive: true });
  await mkdir(moments);
  const contract = { phoenix_harness: 1, name: 'review', run: { command: ['node', 'harness.mjs'] },
    endpoints: { model: { env: 'MODEL_URL' } }, editable: ['prompts/**'] };
  await save(join(repo, 'phoenix.harness.yaml'), contract);
  await writeFile(join(repo, 'prompts/system.md'), 'original\n');
  await writeFile(join(repo, 'readonly.txt'), 'original\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'fixture base');
  let base;
  if (baseChange) base = await baseChange(repo);
  const moment = join(moments, 'm');
  await writeMomentBundle(moment, { manifest: { phoenix_moment: 1, id: 'm', source: 'scenario', start: 'beginning' },
    files: new Map([['check.draft.yaml', JSON.stringify(check)]]) });
  const { bundle, entry } = await approveCheck(moment, { home, who: 'reviewer', reviewed: (await reviewDraft(moment)).digest });
  const settings = join(root, 'settings.json');
  const replaySettings = { image: digest('fixture image'), model: { id: 'fixture', connector: 'model', url: 'http://localhost:1' } };
  await save(settings, replaySettings);
  await createWorkspace({ home, name: 'review', harness: repo, moments, settings, base });
  const opened = await openWorkspace(home, 'review');
  await writeFile(join(opened.tree, 'prompts/system.md'), 'candidate\n');
  const candidate = await freezeCandidate(opened.root, opened.state, opened.contract);
  return { root, repo, home, moment, bundle, entry, opened, candidate, check, replaySettings,
    api: await Workbench.open({ home, workspace: 'review' }) };
}

export async function finishedReplay(f, statuses, { discounted = false, assessment } = {}) {
  const runner = new Runner({ root: f.home, ledger: join(f.home, 'approvals.jsonl') });
  const baseDirectory = await exportTree(f.opened.root, join(f.opened.root, 'tree'), f.opened.state.base, f.opened.state.harness.path);
  const base = { digest: await treeDigest(baseDirectory), directory: baseDirectory };
  const request = { ...f.replaySettings, moment: f.moment, base, candidate: f.candidate, harness: f.opened.contract, start: 'beginning' };
  const id = await runner.plan(request);
  const baseline = await runner.plan({ ...request, candidate: base });
  const directory = runner.directory(id);
  const assessed = assessment ?? await evaluateCheck(f.check, { trace: [] });
  const samples = statuses.map((status, sample) => ({ sample, tiebreak: false, status, discounted,
    attempts: [{ attempt: 0, status: 'finished' }], expectations: assessed.expectations }));
  for (const replay of [id, baseline]) for (const sample of samples) {
    const attempt = join(runner.directory(replay), 'samples', String(sample.sample), '0');
    await mkdir(attempt, { recursive: true });
    await save(join(attempt, 'assessment.json'), assessed);
    await save(join(attempt, 'outcome.json'), { kind: 'finished', code: 0 });
  }
  const verdict = momentVerdict(samples, f.check.samples);
  const result = { phoenix_result: 1, plan: id, check: f.bundle.lock.check, ledger_entry: f.entry,
    start: 'beginning', samples, tiebreak_ran: false, verdict: verdict.verdict,
    ...(verdict.meets_check !== undefined ? { meets_check: verdict.meets_check } : {}), discount: verdict.discount,
    fidelity_grade: discounted ? 'synthesized' : 'recorded' };
  const resultPath = join(directory, 'result.json');
  for (const replay of [id, baseline]) {
    const value = { ...result, plan: replay };
    await save(join(runner.directory(replay), 'result.json'), value);
    await save(join(runner.directory(replay), 'journal.json'), { id: replay, state: 'finished', samples: samples.map(s => ({ ...s, complete: true })), result: value });
  }
  const moments = [{ moment: 'm', replay: id, baseline }];
  const setId = digest(JSON.stringify({ candidate: f.candidate.digest, moments }));
  await mkdir(join(f.opened.root, 'replays'), { recursive: true });
  await save(join(f.opened.root, 'replays', setId.slice(7) + '.json'), { id: setId, created: new Date().toISOString(),
    base: base.digest, candidate: f.candidate, moments });
  await save(join(f.opened.root, 'latest.json'), { replay: setId });
  return { id, setId, resultPath, result, directory };
}
