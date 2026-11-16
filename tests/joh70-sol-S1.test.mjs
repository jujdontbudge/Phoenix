import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { resumeAttempt } from '../packages/runner/src/resume.ts';

test('S1: fx shell cwd home expansion must not escape the files copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-joh70-S1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const time = '2026-11-01T12:00:00.000Z', project = '/controlled-project';
  const rows = [
    { kind: 'session_created', id: 'review', workspace: project },
    { kind: 'set', key: 'prefs', value: { provider: 'codex', model: 'review' } },
    { kind: 'turn_started', turn: 1 },
    { kind: 'item', turn: 1, type: 'user', data: { text: 'Read the project files.', images: [] } },
  ];
  const session = rows.map((row, index) => JSON.stringify({ v: 1, ts: Date.parse(time) + index, ...row })).join('\n') + '\n';
  const extracted = spawnSync(process.execPath, [resolve('recipes/fx/moment.mjs'), '--at', '4'], { input: session, encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const moment = JSON.parse(extracted.stdout);
  const directory = join(root, 'run'), recipeDirectory = join(directory, 'inputs/recipe');
  const archive = join(root, 'archive');
  await mkdir(recipeDirectory, { recursive: true });
  await mkdir(archive);
  await writeFile(join(archive, 'note.txt'), 'FROM_COPY\n');
  await writeFile(join(recipeDirectory, 'recipe.json'), '{}');
  const tar = spawnSync('tar', ['-cf', '-', '-C', archive, 'note.txt']);
  assert.equal(tar.status, 0, tar.stderr.toString());
  const bundle = {
    manifest: { clock: { time }, resume: { moment: 'moment', session: 'session', project: { root: project, source: 'today', taken_at: time, tar: 'tar' } } },
    files: new Map([['moment', Buffer.from(extracted.stdout)], ['session', Buffer.from(session)], ['tar', tar.stdout]]),
  };
  const args = { action: 'run', command: 'pwd', cwd: '~' };
  const loadout = join(root, 'loadout.json'), preload = join(root, 'preload.mjs'), call = join(root, 'call.json');
  await writeFile(loadout, JSON.stringify({ identities: {} }));
  await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const read = fs.readFileSync; fs.readFileSync = (path, ...rest) => read(path === '/phoenix/moment/loadout.json' ? ${JSON.stringify(loadout)} : path, ...rest); syncBuiltinESMExports();\n`);
  let reply;
  const sandbox = { async start() {
    const channel = new Readable({ objectMode: true, read() {} });
    const sockets = new Set();
    const server = createServer(stream => {
      sockets.add(stream);
      stream.once('close', () => sockets.delete(stream));
      channel.push({ destination: { host: 'phoenix-tools', port: 80 }, stream });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const exited = (async () => {
      await writeFile(call, JSON.stringify({ id: 'call-1', name: 'shell', arguments_json: JSON.stringify(args) }));
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload, resolve('recipes/fx/tool.mjs'), call], { env: { ...process.env, HOME: '/home/phoenix', PHOENIX_TOOLS_URL: `http://127.0.0.1:${server.address().port}` } });
      reply = stdout;
      return { code: 0 };
    })();
    return { channel, process: {
      id: 'node-only-review', stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exited, interrupted: new Promise(() => {}), clock: { clock: 'virtual', binaries: [] },
      async stop() { await exited; for (const socket of sockets) socket.destroy(); server.close(); channel.push(null); },
    } };
  } };
  const outcome = await resumeAttempt({
    id: 'review', directory, root: join(directory, 'sample'), bundle, sandbox, capture: 'review', hmacKey: Buffer.alloc(32, 1), started: async () => {},
    plan: { candidate_tree: 'review', runner: { harness: { name: 'fx' }, plugins: [], recipe: { name: 'fx', file: 'recipe.json', resume: { login: [process.execPath, '-e', ''], command: [process.execPath], llm_hosts: { [moment.model.provider]: ['llm.invalid'] } } } } },
  });
  console.log(JSON.stringify({ args, outcome, reply }));
  assert.notEqual(reply[0], '2', 'fx resolves cwd=~ to /home/phoenix, outside /controlled-project; this call must fall through rather than run on the copy');
});
