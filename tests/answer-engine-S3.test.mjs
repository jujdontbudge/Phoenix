import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame } from '../packages/taps/src/index.ts';

test('S3: unrecorded MCP lifecycle notifications must diverge', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 'lifecycle-'));
  const events = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 1, result: { tools: [] } },
  ].map((message, seq) => ({
    v: 1, capture: 'c', stream: 'mcp.fs', seq, id: `mcp.fs:${seq}`,
    kind: seq ? 'result' : 'call', surface: 'mcp', connector: 'fs',
    ts: { wall: '2026-11-15T00:00:00Z' }, body: { inline: JSON.stringify(message) + '\n' },
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
  await link.write(frame('out', 0, Buffer.from(JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 },
  }) + '\n'), true));
  await link.write(frame('out', 1, Buffer.from(events[0].body.inline), true));
  const outcome = await Promise.race([
    link.frames()[Symbol.asyncIterator]().next().then(({ value }) => ({
      kind: 'reply', message: JSON.parse(Buffer.from(value.bytes).toString()),
    })),
    engine.stopped.then(stop => ({ kind: stop.kind, trigger: stop.divergence?.trigger })),
  ]);
  assert.deepEqual(outcome, { kind: 'diverged', trigger: 'lifecycle' });
});
