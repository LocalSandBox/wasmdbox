import assert from 'node:assert/strict';
import { fstatSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Sandbox, SandboxError } from 'wasmdbox';

const cacheDir = fileURLToPath(new URL('../.wasmer/', import.meta.url));
const files = { '/workspace/probe.cjs': await readFile(new URL('./fixtures/mount-guest.cjs', import.meta.url)) };
const command = mode => ['node', '/workspace/probe.cjs', mode];

test('public host mounts through real WASM workers', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-mount-test-'));
  const root = join(directory, 'mounted');
  const outside = join(directory, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'hello.txt'), 'host data');
  await writeFile(join(outside, 'secret.txt'), 'outside secret');
  const mount = { hostPath: root, guestPath: '/mounted' };
  const boxes = new Set();
  t.after(async () => {
    try { await Promise.all([...boxes].map(box => box.close())); }
    finally { await rm(directory, { recursive: true, force: true }); }
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

  await t.test('outside paths, symlinks and hard links cannot reveal host data', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'file-link'));
    await symlink(outside, join(root, 'dir-link'));
    await link(join(outside, 'secret.txt'), join(root, 'hard-link'));
    await run('boundaries', { env: { OUTSIDE_PATH: join(outside, 'secret.txt') } });
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside secret');
    await assert.rejects(readFile(join(root, 'new-link')), { code: 'ENOENT' });
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
    const box = await create();
    assert.equal((await box.exec(command('leak-exit'))).exitCode, 7);
    await box.close();
    assert.deepEqual(descriptorsFor(join(root, 'hello.txt')), []);
  });

  await t.test('closing a running guest releases a descriptor proven open in the host', async () => {
    const box = await create();
    const proc = await box.spawn(command('leak-live'));
    proc.stderr.resume();
    let output = '';
    for await (const chunk of proc.stdout) {
      output += chunk.toString();
      if (output.includes('fd-open')) break;
    }
    assert.match(output, /fd-open/);
    assert.ok(descriptorsFor(join(root, 'hello.txt')).length > 0, 'guest open reaches a native host descriptor');
    await box.close();
    await assert.rejects(proc.wait(), { code: 'SANDBOX_CLOSED' });
    assert.deepEqual(descriptorsFor(join(root, 'hello.txt')), []);
  });
});

// File descriptors are process-wide even when opened inside a Node Worker.
// Match the inode, not an inferred SDK counter or the guest descriptor number.
function descriptorsFor(path) {
  const target = statSync(path);
  const names = readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd');
  const matches = [];
  for (const name of names) {
    try {
      const stat = fstatSync(Number(name));
      if (stat.dev === target.dev && stat.ino === target.ino) matches.push(Number(name));
    } catch { /* Enumeration itself may close an fd before fstat. */ }
  }
  return matches;
}
