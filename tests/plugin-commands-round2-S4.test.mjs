import assert from 'node:assert/strict';
import test from 'node:test';
import { shellCase } from './plugin-commands-round2-helpers.mjs';

test('S4: literal printf stdin still reaches the plugin copy through resume', async t => {
  const result = await shellCase(t, "printf '%s\\n' 'To: test@example.invalid' | mailer template send");
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.observed.stdout, 'To: test@example.invalid\n', 'The recognized literal stdin call must not stop or be made up');
});
