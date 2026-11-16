import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('S3: a failed plugin read prevents the conditional delete from reaching its copy', async t => {
  const result = await shellCase(t, 'mailer message read 999 && mailer message delete 1; mailer envelope list');
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.observed.denied !== undefined || result.observed.stdout === '1\n', 'The failed read must skip deletion, leaving one message, or the copy must not get the line at all');
});
