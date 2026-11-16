import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame } from '../packages/taps/src/index.ts';

test('S4: replay preserves a recorded change notification between MCP calls', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 'notifications-'));
  const messages = [
    ['call', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    ['result', { jsonrpc: '2.0', id: 1, result: { tools: [] } }],
    ['result', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }],
    ['call', { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
    ['result', { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'new', inputSchema: { type: 'object' } }] } }],
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
  await link.write(frame('out', 0, Buffer.from(events[0].body.inline), true));
  await output.next();
  await link.write(frame('out', 1, Buffer.from(events[3].body.inline), true));
  const next = JSON.parse(Buffer.from((await output.next()).value.bytes).toString());
  assert.deepEqual(next, messages[2][1],
    'the notification recorded between the two calls must precede the second result');
});
