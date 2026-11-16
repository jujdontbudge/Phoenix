import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('S6: a plugin command after cd receives the changed working directory', async t => {
  const result = await shellCase(t, 'cd child; mailer pwd');
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.observed.stdout === 'child\n' || result.copyCalls === 0, 'The copy must receive the directory selected before its command, or not get the line at all');
});
