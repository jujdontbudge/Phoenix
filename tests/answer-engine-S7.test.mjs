import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCall, buildIndex, replayCtx, toCall } from '../packages/answer/src/index.ts';

test('S7: captured real evidence becomes recorded provenance during replay', async () => {
  const events = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 1, result: { tools: [] } },
  ].map((message, seq) => ({
    v: 1, capture: 'c', stream: 'mcp.fs', seq, id: `mcp.fs:${seq}`,
    kind: seq ? 'result' : 'call', surface: 'mcp', connector: 'fs',
    ts: { wall: '2026-11-15T00:00:00Z' }, body: { inline: JSON.stringify(message) + '\n' },
    ...(seq ? { provenance: 'real' } : {}),
  }));
  const policy = () => ({});
  const index = await buildIndex(events, {
    body: async event => Buffer.from(event.body.inline), policy,
  });
  const result = await answerCall(toCall({
    surface: 'mcp', connector: 'fs', op: 'tools/list', args: {},
    raw: { body: Buffer.from(events[0].body.inline) },
  }, policy()), replayCtx(index, policy));
  assert.equal(result.answer?.provenance, 'recorded',
    'bytes replayed from a real capture are no longer a live real-system answer');
});
