import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { resumeAttempt } from '../packages/runner/src/resume.ts';
import { readCapture } from '../packages/store/src/index.ts';

async function run(command, args, options, input = '') {
  const child = spawn(command, args, { ...options, stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes);
  child.stderr.on('data', bytes => stderr += bytes);
  child.stdin.end(input);
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

export async function shellCase(t, command, { unsupportedRead = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-plugin-round2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run'), sample = join(root, 'sample');
  const recipeDirectory = join(directory, 'inputs/recipe');
  const answers = join(root, 'answers');
  const runtimeHome = join(root, 'runtime-home');
  for (const path of [recipeDirectory, answers, join(runtimeHome, 'original-project')]) await mkdir(path, { recursive: true });
  await writeFile(join(runtimeHome, 'original-project/value.txt'), 'OUTSIDE-COPY\n');
  await writeFile(join(recipeDirectory, 'recipe.yaml'), '{}');
  const script = join(root, 'serve.mjs');
  await writeFile(script, String.raw`
    import { createInterface } from 'node:readline';
    let messages = 1;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      let value = null;
      if (request.method === 'call') {
        const args = request.params.args.argv.slice(1);
        if (${unsupportedRead} && args[0] === 'message' && args[1] === 'read') {
          console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: 'unsupported', reason: 'The copy has not observed this message body' }));
          continue;
        }
        let stdout = '', stderr = '', code = 0;
        if (args[0] === 'message' && args[1] === 'read') { stderr = 'Message not found\n'; code = 1; }
        if (args[0] === 'message' && args[1] === 'delete') messages = 0;
        if (args[0] === 'envelope') stdout = String(messages) + '\n';
        if (args[0] === 'template') stdout = Buffer.from(request.params.raw.stdin, 'base64').toString();
        if (args[0] === 'pwd') stdout = request.params.args.cwd.endsWith('/child') ? 'child\n' : 'parent\n';
        const frame = (stream, text) => ({ dir: 'back', stream, bytes: Buffer.from(text).toString('base64'), last: true });
        value = { body: Buffer.from(JSON.stringify([
          frame(1, stdout), frame(2, stderr), frame(3, JSON.stringify({ type: 'exit', code, signal: null })),
        ])).toString('base64') };
      }
      console.log(JSON.stringify({ phoenix_plugin: 1, id: request.id, status: 'answer', value }));
    }
  `);
  const descriptor = {
    phoenix_plugin: 1, connector: 'mail', recognize: { commands: ['mailer'] }, tier: 'stateful',
    operations: ['mailer'], read_only: ['mailer envelope list', 'mailer message read'],
    serve: { command: [process.execPath, script], protocol: 'stdio', level: 'tool' },
  };
  const original = join(root, 'original-project');
  const time = '2026-11-16T12:00:00.000Z';
  const moment = {
    cut_lines: 0, prompt: 'Review fixture', model: { provider: 'review', id: 'review' }, loadout: {},
    shell: { 'claude-code': { Bash: { command: 'command' } } }, cwd: original, answers: [],
  };
  const channel = new PassThrough({ objectMode: true });
  const sockets = new Set();
  const server = createServer(stream => {
    sockets.add(stream);
    stream.once('close', () => sockets.delete(stream));
    channel.write({ destination: { host: 'phoenix-tools', port: 80 }, stream });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); channel.end(); });
  let finish, task, observed, failed;
  const exited = new Promise(resolve => finish = resolve);
  const sandbox = { async start(spec) {
    if (spec.argv[0] === process.execPath) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { env: { PATH: process.env.PATH }, stdio: 'pipe' });
      const done = once(child, 'close').then(([code, signal]) => ({ code, signal }));
      return { process: { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
        exited: done, interrupted: new Promise(() => {}), async stop() { child.stdin.end(); await done; } } };
    }
    await mkdir(join(sample, 'box/project/child'), { recursive: true });
    await writeFile(join(sample, 'box/project/value.txt'), 'FILES-COPY\n');
    await symlink(join(sample, 'box/project'), original);
    return { channel, process: {
      id: 'unit-shell', stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exited, interrupted: new Promise(() => {}), clock: { clock: 'real', binaries: [] },
      async stop() { await task; },
    } };
  } };
  const outcome = await resumeAttempt({
    id: 'review', capture: 'review', directory, root: sample, sandbox, hmacKey: Buffer.alloc(32, 1),
    plan: { candidate_tree: 'none', harness_image: 'unused', runner: {
      harness: { name: 'review' }, plugins: [{ descriptor, image: 'unused' }],
      recipe: { name: 'review', file: 'recipe.yaml', resume: {
        login: [process.execPath, '-e', ''], command: ['unit-shell'], llm_hosts: { review: ['example.invalid'] },
      } },
    } },
    bundle: {
      manifest: { resume: { moment: 'moment.json', session: 'session.jsonl', project: {
        root: original, home: root, tar: 'project.tar', source: 'current', taken_at: time,
      } }, clock: { time }, connectors: { 'claude-code': {} } },
      files: new Map([
        ['moment.json', Buffer.from(JSON.stringify(moment))], ['session.jsonl', Buffer.from('')],
        ['project.tar', Buffer.alloc(1024)],
      ]),
    },
    async started() {
      task = (async () => {
        const hooked = await run(process.execPath, [resolve('recipes/claude-code/stand-in.mjs'), 'pre'], {
          env: { PATH: process.env.PATH, HOME: root, PHOENIX_CC_ANSWERS: answers,
            PHOENIX_TOOLS_URL: `http://127.0.0.1:${server.address().port}` },
        }, JSON.stringify({ tool_name: 'Bash', tool_use_id: 'unit-call', tool_input: { command } }));
        if (hooked.code !== 0) throw new Error(hooked.stderr);
        const hook = JSON.parse(hooked.stdout).hookSpecificOutput;
        return hook.permissionDecision === 'allow' ? run('/bin/sh', ['-c', hook.updatedInput?.command ?? command], {
          cwd: join(sample, 'box/project'), env: { PATH: process.env.PATH, HOME: runtimeHome },
        }) : { denied: hook.permissionDecisionReason, decision: hook.permissionDecision };
      })().then(value => observed = value, error => failed = error).finally(() => finish({ code: 0, signal: null }));
    },
  });
  if (failed) throw failed;
  const trace = await readCapture(join(sample, 'trace'));
  const copyCalls = trace.allEvents.filter(e => e.kind === 'call' && e.surface === 'cli').length;
  return { outcome, observed, copyCalls };
}
