import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeMomentBundle, digest, readApprovalsLedger } from '../packages/store/src/index.ts';
import { autoLock, ledgerPath } from '../packages/approvals/src/index.ts';

test('S1: pass acceptance cannot bypass showing the synthesized answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-approvals-S1-'));
  try {
    const home = join(root, 'home');
    const moment = join(root, 'moment');
    await writeMomentBundle(moment, {
      manifest: { phoenix_moment: 1, id: 'm', source: 'scenario', start: 'beginning', lock: 'auto' },
      files: new Map([['check.draft.yaml', JSON.stringify({ phoenix_check: 1,
        samples: { base: 1, tiebreak: 0 }, scope: 'continuation',
        expect: [{ final_text: { contains: 'moved' } }] })]]),
    });
    const { bundle, entry } = await autoLock(moment, { home, who: 'reviewer' });
    const resultPath = join(root, 'result.json');
    await writeFile(resultPath, JSON.stringify({
      phoenix_result: 1, plan: digest('plan'), check: bundle.lock.check, ledger_entry: entry,
      start: 'beginning', tiebreak_ran: false,
      samples: [{ sample: 0, tiebreak: false, status: 'pass', discounted: true,
        attempts: [{ attempt: 0, status: 'finished' }],
        expectations: [{ expectation: 0, outcome: 'pass', tainted: true }] }],
      verdict: 'meets-check', discount: { discounted: true },
    }));
    const command = spawnSync(process.execPath, [resolve('packages/cli/src/pass.ts'),
      'accept', resultPath, '--moment', 'm', '--home', home], { input: 'yes\n', encoding: 'utf8' });
    const { entries } = await readApprovalsLedger(ledgerPath(home));
    assert.equal(entries.filter(e => e.how === 'pass-accepted').length, 0,
      `No answer bodies or source trace were available to show, but the CLI accepted the pass:\n${command.stdout}\n${command.stderr}`);
    assert.notEqual(command.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
