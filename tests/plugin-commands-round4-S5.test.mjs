import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('S5: a tilde-authorized file read must use the session home, not the box home', async t => {
  const result = await shellCase(t, 'cat ~/original-project/value.txt');
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.observed.denied !== undefined || result.observed.stdout === 'FILES-COPY\n', 'The authorized read must not access a same-named file outside the project copy');
});
