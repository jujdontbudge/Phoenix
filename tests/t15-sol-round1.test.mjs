import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContainerSandbox } from '../packages/sandbox/src/index.ts';
import { readPlugin, startServingPlugin } from '../packages/plugin-host/src/index.ts';
import { startEngine } from '../packages/engine/src/index.ts';
import { fidelityReport } from '../packages/fidelity/src/index.ts';
import { readCapture } from '../packages/store/src/index.ts';
import { frame, HTTP_STREAM } from '../packages/taps/src/index.ts';

const time = '2026-11-15T12:00:00.000Z';

async function fixture(level) {
  const root = await mkdtemp(join(import.meta.dirname, 't15-sol-'));
  const op = level === 'http' ? 'GET calendar.test/items' : 'tools/call:list';
  await writeFile(join(root, 'seed.json'), JSON.stringify({ items: [] }));
  await writeFile(join(root, 'serve.mjs'), `
    import { createInterface } from 'node:readline';
    import { readFile } from 'node:fs/promises';
    let seed;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      let value = null;
      if (request.method === 'initialize') seed = JSON.parse(await readFile(request.params.seed, 'utf8'));
      if (request.method === 'state') value = seed;
      if (request.method === 'call') {
        if (request.params.surface === 'http') {
          value = { body: Buffer.from(JSON.stringify(seed)).toString('base64'), head: { status: 200, headers: ['content-type', 'application/json'] } };
        } else {
          const rpc = JSON.parse(Buffer.from(request.params.raw.body, 'base64'));
          value = { body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: 'calendar unavailable' })).toString('base64') };
        }
      }
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: 'answer', value }));
    }
  `);
  await writeFile(join(root, 'phoenix-plugin.json'), JSON.stringify({
    phoenix_plugin: 1, connector: 'calendar', recognize: {}, tier: 'stateful', operations: [op],
    serve: { command: ['node', '/plugin/serve.mjs'], protocol: 'stdio', level },
  }));
  return {
    root,
    plugin: await readPlugin(join(root, 'phoenix-plugin.json')),
    options: {
      context: { snapshot: '/plugin', seed: '/plugin/seed.json' },
      replay: {
        sandbox: new ContainerSandbox(),
        spec: { image: process.env.PHOENIX_TEST_IMAGE ?? 'phoenix-sandbox:proof',
          mounts: [{ source: root, target: '/plugin', readOnly: true }],
          clockFile: join(root, 'clock'), dontFakeMonotonic: true },
      },
    },
  };
}

test('S1: an emulator-served engine response retains stateful fidelity', async t => {
  const { root, plugin, options } = await fixture('http');
  let engine, link;
  t.after(async () => { link?.abort('cleanup'); await engine?.close(); await rm(root, { recursive: true, force: true }); });
  engine = await startEngine({
    emulators: [{ plugin, options }], evidence: { events: [], body: async () => Buffer.alloc(0) },
    clock: { start: time }, routes: {}, hmacKey: Buffer.alloc(32, 1),
    sample: { root: join(root, 'sample'), metadata: { capture: 'sample',
      harness: { name: 'review', tree: 'none' }, recipe: { name: 'review', version: '1' },
      routes: ['replay'], started_at: time, boot_id: 'review' } },
  });
  link = engine.backend.open({ surface: 'http', connector: 'calendar', meta: {
    transport: 'http', request: { method: 'GET', url: '/items', httpVersion: '1.1', headers: ['host', 'calendar.test'] },
  } });
  await link.write(frame('out', HTTP_STREAM.requestBody, Buffer.alloc(0), true));
  const output = link.frames()[Symbol.asyncIterator]();
  assert.equal((await output.next()).value.stream, HTTP_STREAM.responseHead);
  assert.deepEqual(JSON.parse(Buffer.from((await output.next()).value.bytes)), { items: [] });
  await engine.close();
  engine = undefined;
  const capture = await readCapture(join(root, 'sample'));
  const answer = capture.allEvents.find(e => e.kind === 'result');
  assert.equal(answer.resolver, 'emulator');
  assert.equal(answer.provenance, 'derived');
  const context = { v: 1, capture: 'sample', stream: 'context', seq: 0, id: 'context:0',
    kind: 'meta', ts: { wall: time }, op: 'fidelity.context', body: { inline: JSON.stringify({
      source: 'snapshot', connectors: { calendar: { plugin_tier: 'stateful', coverage_tier: 'stateful', origin: 'captured', routes: ['http'] } },
      start: { at: 'beginning' }, container_runtime: 'docker', clock: {}, processes: [],
    }) } };
  const report = fidelityReport([context, ...capture.allEvents]);
  assert.equal(report.connectors[0].tier, 'stateful', 'ARCHITECTURE 3.13: an emulator gives stateful fidelity');
});

test('S2: serving refuses a malformed JSON-RPC error response', async t => {
  const { root, plugin, options } = await fixture('tool');
  let serving;
  t.after(async () => { await serving?.stop(); await rm(root, { recursive: true, force: true }); });
  serving = await startServingPlugin(plugin, options, time);
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list', arguments: {} } }));
  await assert.rejects(serving.call({ surface: 'mcp', layer: 'agent', op: 'tools/call:list', args: {}, raw: { body } }, time),
    /JSON-RPC/, 'JSON-RPC error must be an object with an integer code and a string message');
});
