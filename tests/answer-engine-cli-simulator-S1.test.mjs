import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { SimulatorStore } from '../packages/answer/src/index.ts';
import { startEngine } from '../packages/engine/src/index.ts';
import { HttpModelProvider } from '../packages/model/src/index.ts';
import { cliTap } from '../packages/taps/src/index.ts';

test('S1: an unseen CLI invocation accepts a valid synthesized exit and emits its output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-cli-schema-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reply = { stdout: 'unseen result\n', stderr: 'synthetic warning\n', exit: { code: 0, signal: null } };
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reply) }] }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const provider = new HttpModelProvider({ model: 'review-simulator', endpoint: `http://127.0.0.1:${server.address().port}/responses`, dialect: 'responses', maxOutputTokens: 1024 }, {});
  const invocation = { argv: ['review-tool', 'known'], cwd: '/workspace', env: {}, terminals: { stdin: null, stdout: null, stderr: null } };
  const events = [
    ['call', 'review-tool', invocation],
    ['result', 'frame:back:1', 'known result\n'],
    ['result', 'frame:back:3', { type: 'exit', code: 0, signal: null }],
  ].map(([kind, op, value], seq) => ({
    v: 1, capture: 'synthetic-cli', stream: 'cli.review', seq, id: `cli.review:${seq}`, kind, op,
    surface: 'cli', layer: 'agent', connector: 'review-cli', ts: { wall: '2026-11-15T00:00:00Z', mono: String(seq) },
    body: { inline: typeof value === 'string' ? value : JSON.stringify(value) },
  }));
  const engine = await startEngine({
    evidence: { events, body: async event => Buffer.from(event.body.inline) },
    connectors: { 'review-cli': { allow_synthesized: true, read_only: [{ op: 'review-tool', source: 'plugin' }] } },
    simulator: { moment: 'synthetic-cli-review', provider, improverModel: 'review-improver', store: new SimulatorStore(join(root, 'simulator')) },
    routes: {}, hmacKey: Buffer.alloc(32, 1),
    sample: { root: join(root, 'sample'), metadata: { capture: 'sample', harness: { name: 'review', tree: 'none' },
      recipe: { name: 'review', version: '1' }, routes: ['replay'], started_at: '2026-11-15T00:00:00Z', boot_id: 'review' } },
  });
  t.after(() => engine.close());
  let stdout = '', stderr = '';
  const out = new PassThrough(), err = new PassThrough();
  out.on('data', bytes => { stdout += bytes.toString(); });
  err.on('data', bytes => { stderr += bytes.toString(); });
  const result = await cliTap({ backend: engine.backend, connector: 'review-cli', argv: ['review-tool', 'unseen'], cwd: '/workspace', env: {}, allowEnv: [],
    io: { stdin: Readable.from([]), stdout: out, stderr: err },
  }).catch(async error => ({ error: error.message, stop: await engine.stopped }));
  assert.deepEqual(result, reply.exit, `a valid CLI result must reach the CLI client: ${JSON.stringify(result)}`);
  assert.equal(stdout, reply.stdout);
  assert.equal(stderr, reply.stderr);
});
