import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('S3: an unsupported conditional read cannot stop a successful earlier command', async t => {
  const result = await shellCase(t, 'mailer envelope list || mailer message read --preview 999', { unsupportedRead: true });
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.observed.stdout === '1\n' || result.copyCalls === 0,
    'Either skip the unsupported fallback read, or keep the entire conditional line off the copy');
});
