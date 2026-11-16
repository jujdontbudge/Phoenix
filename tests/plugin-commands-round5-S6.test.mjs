import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('S6: a skipped conditional cd must not change the plugin invocation directory', async t => {
  const result = await shellCase(t, 'ls definitely-missing && cd child; mailer pwd');
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.observed.stdout === 'parent\n' || result.copyCalls === 0,
    'Either preserve the directory when cd is skipped, or keep the ambiguous line off the copy');
});
