import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { startEngine } from '../packages/engine/src/index.ts';
import { frame, HTTP_STREAM } from '../packages/taps/src/index.ts';

test('S6: a recompressed recorded HTTP body must have the correct Content-Length', async t => {
  const root = await mkdtemp(join(import.meta.dirname, 'compressed-'));
  const payload = JSON.stringify({ text: 'Phoenix '.repeat(200) });
  const original = gzipSync(payload, { level: 0 });
  const head = { method: 'GET', url: '/items', headers: ['Host', 'vendor.example'], httpVersion: '1.1' };
  const messages = [
    ['meta', JSON.stringify(head)], ['call', ''],
    ['meta', JSON.stringify({ status: 200, statusMessage: 'OK',
      headers: ['Content-Type', 'application/json', 'Content-Encoding', 'gzip', 'Content-Length', String(original.length)] })],
    ['result', payload],
  ];
  const events = messages.map(([kind, inline], seq) => ({
    v: 1, capture: 'c', stream: 'http.vendor', seq, id: `http.vendor:${seq}`, kind,
    surface: 'http', connector: 'vendor', ts: { wall: '2026-11-15T00:00:00Z' },
    body: { inline, ...(kind === 'result' ? { content_encoding: 'gzip' } : {}) },
  }));
  const engine = await startEngine({
    evidence: { events, body: async event => Buffer.from(event.body.inline) },
    routes: {}, hmacKey: Buffer.alloc(32, 1),
    connectors: { vendor: { surface: 'http', read_only: [{ op: 'GET vendor.example/items', source: 'http-safe-method' }] } },
    sample: { root: join(root, 'sample'), metadata: { capture: 'sample',
      harness: { name: 'review', tree: 'none' }, recipe: { name: 'review', version: '1' },
      routes: ['replay'], started_at: '2026-11-15T00:00:00Z', boot_id: 'review' } },
  });
  const link = engine.backend.open({ surface: 'http', connector: 'vendor', meta: { transport: 'http', request: head } });
  t.after(async () => { link.abort('cleanup'); await engine.close(); await rm(root, { recursive: true, force: true }); });
  await link.write(frame('out', HTTP_STREAM.requestBody, new Uint8Array(), true));
  const output = link.frames()[Symbol.asyncIterator]();
  const response = JSON.parse(Buffer.from((await output.next()).value.bytes).toString());
  const body = (await output.next()).value.bytes;
  const lengthIndex = response.headers.findIndex(name => name.toLowerCase() === 'content-length');
  assert.equal(Number(response.headers[lengthIndex + 1]), body.length,
    'the HTTP parser needs the length of the bytes actually sent, not the original gzip');
});
