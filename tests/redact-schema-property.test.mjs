import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSecrets } from '../packages/redact/src/index.ts';

test('a schema property named like a secret keeps its schema; a real secret value is still stripped', async () => {
  const body = JSON.stringify({ result: { tools: [{ name: 'list', inputSchema: { type: 'object', properties: { page_token: { type: 'string' }, api_key: 'private-value' } } }] } });
  const result = await stripSecrets({ body: Buffer.from(body), contentType: 'application/json' }, { hmacKey: Buffer.alloc(32, 7) });
  const out = JSON.parse(Buffer.from(result.msg.body ?? body).toString());
  const properties = out.result.tools[0].inputSchema.properties;
  assert.deepEqual(properties.page_token, { type: 'string' });
  assert.notEqual(properties.api_key, 'private-value');
});
