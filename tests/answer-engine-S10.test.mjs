import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame } from '../packages/taps/src/index.ts';

test('S10: repeating an observation must not repeat its subsequent change notification', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 'repeat-notification-'));
  const changed = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
  const messages = [
    ['call', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['result', { jsonrpc: '2.0', id: 1, result: { tools: [] } }],
    ['result', changed],
  ];
  const events = messages.map(([kind, message], seq) => ({
    v: 1, capture: 'c', stream: 'mcp.fs', seq, id: `mcp.fs:${seq}`, kind,
    surface: 'mcp', connector: 'fs', ts: { wall: '2026-11-15T00:00:00Z' },
    body: { inline: JSON.stringify(message) + '\n' },
  }));
  const engine = await startEngine({
    evidence: { events, body: async event => Buffer.from(event.body.inline) },
    routes: {}, hmacKey: Buffer.alloc(32, 1),
    sample: { root: join(root, 'sample'), metadata: { capture: 'sample',
      harness: { name: 'review', tree: 'none' }, recipe: { name: 'review', version: '1' },
      routes: ['replay'], started_at: '2026-11-15T00:00:00Z', boot_id: 'review' } },
  });
  const link = engine.backend.open({ surface: 'mcp', connector: 'fs', meta: { transport: 'stdio' } });
  t.after(async () => { link.abort('cleanup'); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const output = link.frames()[Symbol.asyncIterator]();
  const decode = value => JSON.parse(Buffer.from(value.bytes).toString());
  await link.write(frame('out', 0, Buffer.from(events[0].body.inline), true));
  assert.equal(decode((await output.next()).value).id, 1);
  assert.deepEqual(decode((await output.next()).value), changed);
  await link.write(frame('out', 1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'), true));
  assert.equal(decode((await output.next()).value).id, 2);
  await link.write(frame('out', 2, new Uint8Array(), true));
  const next = await output.next();
  assert.deepEqual(next.done ? { done: true } : decode(next.value), { done: true },
    'a derived repeat is an observation, not a new server-side tool-list change');
});
