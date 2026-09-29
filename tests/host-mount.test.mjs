import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Sandbox, SandboxError } from 'wasmdbox';

const cacheDir = fileURLToPath(new URL('../.wasmer/', import.meta.url));
const files = { '/workspace/probe.cjs': await readFile(new URL('./fixtures/mount-guest.cjs', import.meta.url)) };
const command = mode => ['node', '/workspace/probe.cjs', mode];

test('public host mounts through real WASM workers', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-mount-test-'));
  const root = join(directory, '挂载 目录');
  const outside = join(directory, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'hello.txt'), 'host data');
  await writeFile(join(outside, 'secret.txt'), 'outside secret');
  const mount = { hostPath: root, guestPath: '/mounted' };
  const report = join(directory, 'handles.jsonl');
  await writeFile(report, '');
  const previousReport = process.env.WASMDBOX_MOUNT_REPORT;
  const previousTarget = process.env.WASMDBOX_MOUNT_OBSERVE;
  const previousArgs = [...process.execArgv];
  process.env.WASMDBOX_MOUNT_REPORT = report;
  process.env.WASMDBOX_MOUNT_OBSERVE = join(root, 'hello.txt');
  process.execArgv.push('--import', new URL('./fixtures/mount-observer.mjs', import.meta.url).href);
  const boxes = new Set();
  t.after(async () => {
    try { await Promise.all([...boxes].map(box => box.close())); }
    finally {
      process.execArgv.splice(0, process.execArgv.length, ...previousArgs);
      if (previousReport === undefined) delete process.env.WASMDBOX_MOUNT_REPORT;
      else process.env.WASMDBOX_MOUNT_REPORT = previousReport;
      if (previousTarget === undefined) delete process.env.WASMDBOX_MOUNT_OBSERVE;
      else process.env.WASMDBOX_MOUNT_OBSERVE = previousTarget;
      await rm(directory, { recursive: true, force: true });
    }
  });
  async function create(options = {}) {
    const box = await Sandbox.create({ cacheDir, files, mounts: [mount], ...options });
    boxes.add(box);
    return box;
  }
  async function run(mode, options) {
    const box = await create(options);
    try { return await box.exec(command(mode), { timeoutMs: 30_000, check: true }); }
    finally { await box.close(); }
  }

  await t.test('append, descriptor writes, fsync and exclusive creation persist', async () => {
    await run('append');
    assert.equal(await readFile(join(root, 'appended.txt'), 'utf8'), 'first-second');
  });

  await t.test('read-only mounts reject append, truncate and directory mutations', async () => {
    await run('readonly', { mounts: [{ ...mount, readOnly: true }] });
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'host data');
  });

  await t.test('relative host paths and Unicode guest filenames write through', async () => {
    await run('unicode', { mounts: [{ ...mount, hostPath: relative(process.cwd(), root) }] });
    assert.equal(await readFile(join(root, '中文 文件.txt'), 'utf8'), 'unicode content');
  });

  await t.test('outside paths, directory links and hard links cannot reveal host data', async () => {
    await symlink(outside, join(root, 'dir-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await link(join(outside, 'secret.txt'), join(root, 'hard-link'));
    await run('boundaries', { env: { OUTSIDE_PATH: join(outside, 'secret.txt') } });
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside secret');
    await assert.rejects(readFile(join(root, 'new-link')), { code: 'ENOENT' });
  });

  await t.test('file symlinks cannot reveal host data', async t => {
    try { await symlink(join(outside, 'secret.txt'), join(root, 'file-link'), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Creating symlinks requires Windows privileges or Developer Mode');
      throw error;
    }
    await run('file-link');
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside secret');
  });

  await t.test('Windows guest cannot open devices or alternate streams', { skip: process.platform !== 'win32' }, async () => {
    await writeFile(join(root, 'hello.txt:private'), 'private stream');
    await run('windows-paths');
    assert.equal(await readFile(join(root, 'hello.txt:private'), 'utf8'), 'private stream');
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'host data');
  });

  await t.test('invalid and partly registered mounts roll back without breaking another sandbox', async () => {
    const survivor = await create();
    try {
      for (const mounts of [
        [{ ...mount, guestPath: '/workspace' }],
        [mount, { ...mount, guestPath: '/mounted/nested' }],
        [mount, { hostPath: join(directory, 'missing'), guestPath: '/missing' }],
      ]) await assert.rejects(create({ mounts }), SandboxError);
      assert.equal((await survivor.exec(command('read'), { check: true })).stdout, 'host data\n');
    } finally { await survivor.close(); }
  });

  await t.test('public sandboxes have independent mount lifetimes and observe host edits', async () => {
    const first = await create();
    const second = await create();
    try {
      await first.close();
      await writeFile(join(root, 'hello.txt'), 'updated after first close');
      assert.equal((await second.exec(command('read'), { check: true })).stdout, 'updated after first close\n');
      await assert.rejects(first.exec(command('read')), { code: 'SANDBOX_CLOSED' });
    } finally { await Promise.all([first.close(), second.close()]); }
  });

  await t.test('abnormal guest exit and close do not leave an open host descriptor', async () => {
    const start = observations(report).length;
    const box = await create();
    assert.equal((await box.exec(command('leak-exit'))).exitCode, 7);
    await box.close();
    assertReleased(observations(report).slice(start));
  });

  await t.test('closing a running guest releases a descriptor proven open in the host', async () => {
    const start = observations(report).length;
    const box = await create();
    const proc = await box.spawn(command('leak-live'));
    proc.stderr.resume();
    let output = '';
    for await (const chunk of proc.stdout) {
      output += chunk.toString();
      if (output.includes('fd-open')) break;
    }
    assert.match(output, /fd-open/);
    assert.ok(activeHandles(observations(report).slice(start)).size > 0, 'guest open reaches a native host descriptor');
    await box.close();
    await assert.rejects(proc.wait(), { code: 'SANDBOX_CLOSED' });
    assertReleased(observations(report).slice(start));
  });
});

function observations(report) {
  return readFileSync(report, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function activeHandles(events) {
  const active = new Set();
  for (const event of events) {
    const key = `${event.threadId}:${event.id}`;
    if (event.type === 'open') active.add(key);
    else active.delete(key);
  }
  return active;
}

function assertReleased(events) {
  assert.ok(events.some(event => event.type === 'open'), 'must observe a native host open');
  assert.equal(activeHandles(events).size, 0, 'every native open must be closed');
  for (const event of events.filter(event => event.type === 'close')) {
    assert.equal(event.released, true, 'fstat on the closed descriptor must return EBADF');
  }
}
