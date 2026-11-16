import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recognizeCommand, startToolStandIn } from '../packages/engine/src/index.ts';
import { BlobStore, readCapture } from '../packages/store/src/index.ts';

test('S1: plugin CLI stdout is secret-stripped in every persisted trace representation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-plugin-commands-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = 'synthetic-review-only-password';
  const stdout = JSON.stringify({ password: marker });
  const frames = [
    { dir: 'back', stream: 1, bytes: Buffer.from(stdout).toString('base64'), last: true },
    { dir: 'back', stream: 3, bytes: Buffer.from(JSON.stringify({ type: 'exit', code: 0, signal: null })).toString('base64'), last: true },
  ];
  const script = join(root, 'serve.mjs');
  await writeFile(script, `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const value = request.method === 'call'
        ? { body: ${JSON.stringify(Buffer.from(JSON.stringify(frames)).toString('base64'))} } : null;
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: 'answer', value }));
    }
  `);
  const descriptor = {
    phoenix_plugin: 1, connector: 'mail', recognize: { commands: ['mailer'] }, tier: 'stateful',
    operations: ['mailer'], read_only: ['mailer message read --preview'],
    serve: { command: [process.execPath, script], protocol: 'stdio', level: 'tool' },
  };
  const sandbox = { async start(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { env: { PATH: process.env.PATH }, stdio: 'pipe' });
    const exited = once(child, 'close').then(([code, signal]) => ({ code, signal }));
    return { process: { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      exited, interrupted: new Promise(() => {}), async stop() { child.stdin.end(); await exited; } } };
  } };
  const time = '2026-11-16T12:00:00.000Z';
  const standIn = await startToolStandIn({
    host: 'phoenix-tools', answers: [], policy: () => ({}),
    pluginCommand: (_connector, _op, args) => {
      const found = recognizeCommand(args.command, [descriptor]);
      return found && { calls: found.calls.map(call => ({ ...call, env: call.env ?? {}, cwd: '/project' })), around: found.around };
    },
    emulators: [{ plugin: { directory: root, descriptor }, options: {
      context: {}, replay: { sandbox, spec: { image: 'unused', mounts: [], clockFile: join(root, 'clock') } },
    } }],
    sample: { root: join(root, 'trace'), metadata: { capture: 'S1',
      harness: { name: 'review', tree: 'none' }, recipe: { name: 'review', version: '1' },
      routes: ['tap'], started_at: time, boot_id: 'review' } }, hmacKey: Buffer.alloc(32, 1),
  });
  t.after(() => standIn.close());
  const sockets = new Set();
  const server = createServer(stream => {
    sockets.add(stream);
    stream.once('close', () => sockets.delete(stream));
    standIn.accept({ destination: { host: 'phoenix-tools', port: 80 }, stream });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/shell`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'exec', arguments: { command: 'mailer message read --preview 1' },
    } }),
  });
  assert.equal((await response.json()).command_output.outputs[0].stdout, stdout);
  const capture = await readCapture(join(root, 'trace'));
  const blobs = new BlobStore(join(root, 'trace'));
  const body = async event => 'inline' in event.body ? event.body.inline : Buffer.from(await blobs.get(event.body.blob)).toString();
  const agentResult = capture.allEvents.find(e => e.kind === 'result' && e.layer === 'agent');
  assert.equal((await body(agentResult)).includes(marker), false);
  const cliResult = capture.allEvents.find(e => e.kind === 'result' && e.surface === 'cli');
  const stored = JSON.parse(await body(cliResult));
  const persistedStdout = Array.isArray(stored) ? stored.filter(f => f.stream === 1).map(f => Buffer.from(f.bytes, 'base64').toString()).join('') : stored.stdout;
  assert.equal(persistedStdout.includes(marker), false,
    'The under-layer CLI result must not retain a secret that the agent-layer result stripped');
});
