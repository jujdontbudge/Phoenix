import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame } from '../packages/taps/src/index.ts';

test('S8: replay accepts two writes that were already concurrent in the recording', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 'concurrent-'));
  const messages = [
    ['call', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'a.txt', content: 'a' } } }],
    ['call', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'b.txt', content: 'b' } } }],
    ['result', { jsonrpc: '2.0', id: 1, result: { content: [] } }],
    ['result', { jsonrpc: '2.0', id: 2, result: { content: [] } }],
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
  await link.write(frame('out', 1, Buffer.from(events[1].body.inline), true));
  assert.equal(JSON.parse(Buffer.from((await output.next()).value.bytes).toString()).id, 1);
  const stop = engine.stopped.then(value => ({ kind: value.kind, trigger: value.divergence?.trigger }));
  const outcome = await Promise.race([
    output.next().then(({ value }) => ({ kind: 'result', id: JSON.parse(Buffer.from(value.bytes).toString()).id })).catch(() => stop),
    stop,
  ]);
  assert.deepEqual(outcome, { kind: 'result', id: 2 },
    'unchanged pipelined requests must not acquire a different write history during replay');
});
