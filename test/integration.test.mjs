import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { createRecorder, replayCasefile, validateCasefile, MAX_BYTES } from '../dist/index.js';
import { exportRegression, loadCasefile, writePrivateNew } from '../dist/io.js';
import { startInspector } from '../dist/server.js';
const rawExec = promisify(execFile);
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const exec = (file, args, options = {}) => rawExec(file, args, { env: childEnv, ...options });
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const fixture = JSON.parse(
  await readFile(new URL('../examples/tool-timeout-fixed.casefile.json', import.meta.url), 'utf8'),
);
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'casefile-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function run(args, options = {}) {
  try {
    const r = await exec(process.execPath, [cli, ...args], { cwd: root, ...options });
    return { ...r, code: 0 };
  } catch (e) {
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
}
const options = () => ({
  id: 'recorded-demo',
  title: 'Local recorder',
  environment: { runtime: 'Node.js' },
  assertions: [
    { id: 'settled', kind: 'calls.settled', boundary: 'all' },
    { id: 'outcome', kind: 'run.outcome', equals: 'success' },
  ],
});

test('recorder captures real injected callbacks, snapshots input, and preserves return value', async () => {
  const recorder = createRecorder(options());
  const input = { question: 'hello' };
  let executions = 0;
  const result = await recorder.model(input, async (x) => {
    executions++;
    x.question = 'mutated';
    return { answer: 'world' };
  });
  assert.deepEqual(result, { answer: 'world' });
  assert.equal(executions, 1);
  await recorder.tool('length', { text: 'world' }, (x) => ({ length: x.text.length }));
  const c = recorder.finish('success');
  assert.equal(c.provenance.kind, 'recorded');
  assert.equal(c.events[0].data.question, 'hello');
  assert.equal(replayCasefile(c).status, 'pass');
  result.answer = 'later mutation';
  assert.equal(c.events[1].data.answer, 'world');
});
test('recorder preserves thrown error identity without capturing a stack', async () => {
  const recorder = createRecorder({ ...options(), assertions: [] });
  const error = new Error('local timeout');
  error.name = 'TimeoutError';
  await assert.rejects(
    recorder.tool('slow', {}, () => {
      throw error;
    }),
    (e) => e === error,
  );
  const c = recorder.finish('error');
  assert.equal(c.events[1].outcome, 'timeout');
  assert.deepEqual(c.events[1].data, { error: { name: 'TimeoutError', message: 'local timeout' } });
  assert.equal(JSON.stringify(c).includes('stack'), false);
});
test('recorder rejects finishing while pending and subsequent use after finish', async () => {
  const recorder = createRecorder(options());
  let done;
  const result = recorder.tool(
    'wait',
    {},
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  assert.throws(() => recorder.finish('success'), /pending/);
  done({ ok: true });
  await result;
  recorder.finish('success');
  assert.throws(() => recorder.finish('success'), /finished/);
  await assert.rejects(
    recorder.model({}, () => ({})),
    /finished/,
  );
});
test('non-JSON callback results do not change application result but mark capture partial', async () => {
  const recorder = createRecorder(options());
  const result = await recorder.model({}, () => undefined);
  assert.equal(result, undefined);
  const c = recorder.finish('success');
  assert.equal(c.capture.status, 'partial');
  assert.equal(c.events[1].data, null);
  assert.equal(replayCasefile(c).status, 'inconclusive');
});
test('invalid recorder input is rejected before invoking callback', async () => {
  let called = false;
  const recorder = createRecorder(options());
  await assert.rejects(
    recorder.model({ bad: undefined }, () => {
      called = true;
      return {};
    }),
    /JSON/,
  );
  assert.equal(called, false);
});
test('recorder supports concurrent calls without mis-pairing', async () => {
  const recorder = createRecorder(options());
  await Promise.all([
    recorder.tool('a', {}, async () => ({ a: 1 })),
    recorder.tool('b', {}, async () => ({ b: 2 })),
  ]);
  const c = recorder.finish('success');
  assert.equal(validateCasefile(c).valid, true);
  assert.equal(replayCasefile(c).status, 'pass');
});

test('file intake bounds reads, rejects directories and invalid UTF-8', async (t) => {
  const dir = await temp(t);
  await writeFile(join(dir, 'huge'), Buffer.alloc(MAX_BYTES + 1));
  await assert.rejects(loadCasefile(join(dir, 'huge')), /5 MiB/);
  await assert.rejects(loadCasefile(dir), /regular file/);
  await writeFile(join(dir, 'bad'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(loadCasefile(join(dir, 'bad')));
});
test('private writes do not overwrite files or symlinks', async (t) => {
  const dir = await temp(t);
  const target = join(dir, 'out.json');
  await writePrivateNew(target, 'original');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await assert.rejects(writePrivateNew(target, 'changed'), { code: 'EEXIST' });
  const link = join(dir, 'link');
  await symlink(target, link);
  await assert.rejects(writePrivateNew(link, 'changed'), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'original');
});
test('portable export is redacted, executable without installation, hashed and private', async (t) => {
  const dir = await temp(t);
  const out = join(dir, 'artifact');
  const result = await exportRegression(fixture, out);
  assert.ok(result.redactions >= 2);
  const raw = await readFile(join(out, 'casefile.json'), 'utf8');
  assert.equal(raw.includes('engineer@example.test'), false);
  assert.equal(raw.includes('not-a-real-key'), false);
  assert.ok(raw.includes('[REDACTED]'));
  const execution = await exec(process.execPath, ['--test', join(out, 'regression.test.mjs')], {
    cwd: dir,
  });
  assert.match(execution.stdout, /fail 0/);
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  for (const [name, hash] of Object.entries(manifest.files))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(out, name)))
        .digest('hex'),
      hash,
    );
  assert.ok(result.files.includes('LICENSE'));
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  assert.equal((await stat(join(out, 'casefile.json'))).mode & 0o777, 0o600);
});
test('export refuses an existing directory or symlink without changing contents', async (t) => {
  const dir = await temp(t);
  const out = join(dir, 'existing');
  await mkdir(out);
  await writeFile(join(out, 'keep'), 'unchanged');
  await assert.rejects(exportRegression(fixture, out), { code: 'EEXIST' });
  assert.equal(await readFile(join(out, 'keep'), 'utf8'), 'unchanged');
  const link = join(dir, 'link');
  await symlink(out, link);
  await assert.rejects(exportRegression(fixture, link), { code: 'EEXIST' });
});
test('redacted evidence and failing evidence make exported tests fail closed', async (t) => {
  const dir = await temp(t);
  const c = structuredClone(fixture);
  c.assertions.push({
    id: 'privacy-sensitive',
    kind: 'value.equals',
    eventId: c.events[2].id,
    pointer: '/data/requesterEmail',
    expected: 'engineer@example.test',
  });
  const out = join(dir, 'artifact');
  await exportRegression(c, out);
  await assert.rejects(
    exec(process.execPath, ['--test', join(out, 'regression.test.mjs')]),
    (e) => e.code === 1 && e.stdout.includes('inconclusive'),
  );
});
test('casefile contents never become executable export source', async (t) => {
  const dir = await temp(t);
  const c = structuredClone(fixture);
  c.description = "'); process.exit(99); // </script>";
  c.events[0].data = { message: '${process.exit(99)}' };
  const out = join(dir, 'artifact');
  await exportRegression(c, out);
  const runner = await readFile(join(out, 'regression.test.mjs'), 'utf8');
  assert.equal(runner.includes('process.exit(99)'), false);
  await exec(process.execPath, ['--test', join(out, 'regression.test.mjs')]);
});

test('CLI help, invalid usage and missing input have predictable exit codes', async () => {
  assert.equal((await run(['--help'])).code, 0);
  assert.equal((await run(['--version'])).stdout.trim(), '0.1.0');
  for (const args of [
    ['unknown'],
    ['replay'],
    ['replay', 'missing.json'],
    ['validate', 'x', '--out', 'y'],
    ['inspect', '--port', '0'],
    ['export', 'examples/tool-timeout.casefile.json'],
  ])
    assert.equal((await run(args)).code, 2);
});
test('CLI JSON output is machine-readable and never includes raw boundary payloads', async () => {
  const result = await run(['replay', 'examples/tool-timeout.casefile.json', '--json']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).status, 'fail');
  assert.equal(result.stdout.includes('engineer@example.test'), false);
  assert.equal((await run(['replay', 'examples/tool-timeout-fixed.casefile.json'])).code, 0);
  assert.equal((await run(['replay', 'examples/incomplete.casefile.json'])).code, 3);
  const redact = await run(['redact', 'examples/tool-timeout.casefile.json', '--json']);
  assert.equal(JSON.parse(redact.stdout).mode, 'preview');
  assert.equal(redact.stdout.includes('engineer@example.test'), false);
});
test('CLI invalid JSON emits safe diagnostics, not pasted source', async (t) => {
  const dir = await temp(t);
  const input = join(dir, 'bad.json');
  await writeFile(input, 'PRIVATE_PASTED_VALUE');
  const result = await run(['validate', input, '--json']);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).valid, false);
  assert.equal(result.stdout.includes('PRIVATE_PASTED_VALUE'), false);
});
test('documented local capture demo reruns actual local functions and retains fixed assertions', async (t) => {
  const dir = await temp(t);
  const script = join(root, 'examples/capture-local.mjs');
  const broken = join(dir, 'capture-broken.local.casefile.json'),
    fixed = join(dir, 'capture-fixed.local.casefile.json');
  await assert.rejects(exec(process.execPath, [script], { cwd: dir }), (e) => e.code === 1);
  await exec(process.execPath, [script, '--fixed'], { cwd: dir });
  const a = JSON.parse(await readFile(broken, 'utf8')),
    b = JSON.parse(await readFile(fixed, 'utf8'));
  assert.equal(a.provenance.kind, 'recorded');
  assert.deepEqual(a.assertions, b.assertions);
  assert.equal(replayCasefile(a).status, 'fail');
  assert.equal(replayCasefile(b).status, 'pass');
});

test('inspector binds loopback, serves allowlisted assets, and rejects remote origin / writes', async (t) => {
  const server = await startInspector(fixture, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await index.text(), /Agent Casefile/);
  assert.equal((await fetch(base + '/casefile.json')).status, 200);
  assert.equal((await fetch(base + '/lib/index.js')).status, 200);
  assert.equal((await fetch(base + '/examples/tool-timeout.casefile.json')).status, 200);
  for (const path of ['/package.json', '/.env', '/src/cli.ts', '/%2e%2e/package.json'])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal(
    await new Promise((resolve, reject) => {
      const req = request(base, { headers: { Host: 'evil.invalid' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    }),
    403,
  );
  assert.equal((await fetch(base, { method: 'POST', body: 'no' })).status, 405);
  assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
});

test('human CLI redaction preview escapes hostile property-name controls', async (t) => {
  const dir = await temp(t);
  const c = structuredClone(fixture);
  c.events[0].data = { ['\u001b]52;c;synthetic\u0007\nspoofed']: { password: 'synthetic' } };
  const file = join(dir, 'controls.json');
  await writeFile(file, JSON.stringify(c));
  const result = await run(['redact', file]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes('\u001b'), false);
  assert.equal(result.stdout.includes('\u0007'), false);
  assert.ok(result.stdout.includes('\\u001b'));
  assert.equal(result.stdout.includes('\nspoofed'), false);
});

test('CLI redaction and regression export round-trip highly indented valid evidence', async (t) => {
  const dir = await temp(t);
  const c = structuredClone(fixture);
  c.events[0].data = Array.from({ length: 3000 }, () => {
    let v = 0;
    for (let i = 0; i < 26; i++) v = { x: v };
    return v;
  });
  const input = join(dir, 'input.json'),
    output = join(dir, 'redacted.json');
  await writeFile(input, JSON.stringify(c));
  assert.equal((await run(['redact', input, '--out', output])).code, 0);
  assert.equal((await loadCasefile(output)).valid, true);
  assert.ok((await stat(output)).size <= MAX_BYTES);
  const out = join(dir, 'artifact');
  await exportRegression(c, out);
  assert.equal((await loadCasefile(join(out, 'casefile.json'))).valid, true);
  await exec(process.execPath, ['--test', join(out, 'regression.test.mjs')]);
});
