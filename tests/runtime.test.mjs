import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Sandbox, SandboxError, CommandError } from 'wasmdbox';

const cacheDir = fileURLToPath(new URL('../.wasmer/', import.meta.url));
const source = await readFile(new URL('./fixtures/runtime.cjs', import.meta.url));
const files = { '/workspace/probe.cjs': source };
const command = mode => ['node', '/workspace/probe.cjs', mode];

test('public command, output, stdin and lifecycle contract', { timeout: 240_000 }, async t => {
  process.env.WASMDBOX_HOST_ONLY = 'must not enter guest';
  const box = await Sandbox.create({ cacheDir, files, env: { DEMO_VALUE: 'base' } });
  t.after(() => box.close());
  t.after(() => { delete process.env.WASMDBOX_HOST_ONLY; });
  assert.equal('fs' in box, false);

  await t.test('argv is literal, env is explicit, Node and Bash are ready', async () => {
    const out = await box.exec([...command('info'), 'a b', '$(not-a-shell)'], { env: { DEMO_VALUE: 'override' }, check: true });
    assert.deepEqual(JSON.parse(out.stdout), { argv: ['a b', '$(not-a-shell)'], cwd: '/workspace', env: 'override' });
    assert.equal((await box.exec(['bash', '-c', 'printf shell-ready'], { check: true })).stdout, 'shell-ready');
  });
  await t.test('guest errors return outputs; checked exits use independent CommandError', async () => {
    const out = await box.exec(command('nonzero'));
    assert.equal(out.exitCode, 7);
    assert.match(out.stdout, /before exit/);
    assert.match(out.stderr, /guest diagnostic/);
    await assert.rejects(box.exec(command('nonzero'), { check: true }), error => {
      assert.ok(error instanceof CommandError);
      assert.equal(error instanceof SandboxError, false);
      assert.equal(error.code, 'NON_ZERO_EXIT');
      assert.equal(error.result.exitCode, 7);
      return true;
    });
    assert.notEqual((await box.exec(command('throw'))).exitCode, 0);
    await assert.rejects(box.exec(['no-such-command']), { name: 'CommandError', code: 'COMMAND_NOT_FOUND' });
    assert.equal((await box.exec(command('info'))).exitCode, 0);
  });
  await t.test('exec stdin closes with EOF', async () => {
    assert.equal((await box.exec(command('stdin'), { stdin: 'hello', check: true })).stdout, 'HELLO\n');
  });
  await t.test('stream stdin, output and wait share the same command', async () => {
    const proc = await box.spawn(command('stdin'), { stdin: 'pipe', check: true });
    proc.stdin.end('stream');
    const stdout = collect(proc.stdout);
    const stderr = collect(proc.stderr);
    const output = await proc.wait();
    assert.equal(await stdout, output.stdout);
    assert.equal(await stderr, output.stderr);
    assert.equal(output.stdout, 'STREAM\n');
  });
  await t.test('unconsumed streams and captured output are bounded', async () => {
    const proc = await box.spawn(command('large'), { outputBytes: 17, check: true });
    const out = await proc.wait();
    assert.equal(out.stdout, 'O'.repeat(17));
    assert.equal(out.stderr, 'E'.repeat(17));
    assert.equal(out.stdoutTruncated, true);
    assert.equal(out.stderrTruncated, true);
    assert.equal(await collect(proc.stdout), out.stdout);
    assert.equal(await collect(proc.stderr), out.stderr);
  });
  await t.test('warm deadline and AbortSignal throw with partial output', async () => {
    await assert.rejects(box.exec(command('wait'), { timeoutMs: 500 }), error => error instanceof CommandError && error.code === 'TIMEOUT');
    const abort = new AbortController();
    const pending = box.exec(command('wait'), { signal: abort.signal });
    setTimeout(() => abort.abort(), 500);
    await assert.rejects(pending, { name: 'CommandError', code: 'ABORTED' });
    const proc = await box.spawn(command('wait'));
    proc.stdout.resume(); proc.stderr.resume();
    await proc.kill();
    await assert.rejects(proc.wait(), { code: 'KILLED' });
    assert.equal((await box.exec(command('info'))).exitCode, 0);
  });
  await t.test('close is shared, rejects active work and disallows subsequent commands', async () => {
    const pending = box.exec(command('wait'));
    const first = box.close();
    assert.equal(first, box.close());
    await assert.rejects(pending, { code: 'SANDBOX_CLOSED' });
    await first;
    await box.close();
    await assert.rejects(box.exec(command('info')), { name: 'SandboxError', code: 'SANDBOX_CLOSED' });
  });
});

test('cold command timeout cannot return a late success', { timeout: 240_000 }, async t => {
  const box = await Sandbox.create({ cacheDir });
  t.after(() => box.close());
  const before = Date.now();
  await assert.rejects(box.exec(['bash', '-c', 'sleep 1'], { timeoutMs: 20 }), error => {
    assert.ok(error instanceof CommandError || error instanceof SandboxError);
    assert.ok(['TIMEOUT', 'SANDBOX_UNRESPONSIVE'].includes(error.code));
    return true;
  });
  assert.ok(Date.now() - before < 4_000, 'deadline plus cleanup must be bounded');
});

test('cancellation stops real host writes and other sandboxes remain usable', { timeout: 240_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wasmdbox-lifecycle-'));
  const box = await Sandbox.create({ cacheDir, files, mounts: [{ hostPath: root, guestPath: '/mounted' }] });
  const other = await Sandbox.create({ cacheDir, files });
  t.after(async () => { await Promise.all([box.close(), other.close()]); await rm(root, { recursive: true, force: true }); });
  await box.exec(command('info'), { check: true });
  const controller = new AbortController();
  const cancelled = box.exec(command('ticker'), { signal: controller.signal });
  void cancelled.catch(() => {});
  await waitForWrite(join(root, 'ticks.txt'), '');
  controller.abort();
  await assert.rejects(cancelled, { code: 'ABORTED' });
  const stopped = await readFile(join(root, 'ticks.txt'), 'utf8');
  await delay(150);
  assert.equal(await readFile(join(root, 'ticks.txt'), 'utf8'), stopped);
  const pending = box.exec(command('ticker'));
  void pending.catch(() => {});
  await waitForWrite(join(root, 'ticks.txt'), stopped);
  const closing = box.close();
  await assert.rejects(pending, { code: 'SANDBOX_CLOSED' });
  const closed = await readFile(join(root, 'ticks.txt'), 'utf8');
  await delay(100);
  assert.equal(await readFile(join(root, 'ticks.txt'), 'utf8'), closed, 'closed command settlement means guest writes have stopped');
  await closing;
  assert.equal((await other.exec(command('info'))).exitCode, 0);
});

test('creation validation, deadline, cancellation and mount failure clean up', { timeout: 240_000 }, async () => {
  await assert.rejects(Sandbox.create({ startupTimeoutMs: -1 }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(Sandbox.create({ signal: {} }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(Sandbox.create({ cacheDir, signal: AbortSignal.abort() }), { code: 'STARTUP_ABORTED' });
  await assert.rejects(Sandbox.create({ cacheDir, startupTimeoutMs: 0 }), { code: 'STARTUP_TIMEOUT' });
  await assert.rejects(Sandbox.create({ cacheDir, mounts: [{ hostPath: '/wasmdbox-missing-directory', guestPath: '/mounted' }] }), { code: 'CREATE_FAILED' });
  await assert.rejects(Sandbox.create({ cacheDir, network: { secrets: { API_KEY: null } } }), { code: 'CREATE_FAILED' });
  const box = await Sandbox.create({ cacheDir });
  await assert.rejects(box.exec(['node'], { signal: {} }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(box.spawn(['node'], null), { code: 'INVALID_OPTIONS' });
  await box.close();
});

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function waitForWrite(path, previous) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await readFile(path, 'utf8') !== previous) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.fail('guest did not write before the readiness deadline');
}
