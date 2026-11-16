import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets } from '../packages/redact/src/index.ts';

test('object-valued credentials in ordinary properties data remain secret-stripped', async () => {
  const value = 'synthetic-credential-for-review-only';
  const body = JSON.stringify({ properties: { credentials: { value } } });
  const result = await stripSecrets(
    { body: Buffer.from(body), contentType: 'application/json' },
    { hmacKey: Buffer.alloc(32, 7) },
  );
  assert.equal(result.unscanned.length, 0);
  assert.equal(Buffer.from(result.msg.body).toString().includes(value), false);
});
