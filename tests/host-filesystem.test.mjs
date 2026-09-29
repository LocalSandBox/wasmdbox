import assert from 'node:assert/strict';
import nativeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  closeHostMounts,
  dispatchHostFileSystem,
  hostFileSystemStats,
  registerHostMounts,
} from '../dist/internal/node-host-filesystem.js';

function fixture(t) {
  const baseline = hostFileSystemStats();
  const directory = fs.mkdtempSync(join(tmpdir(), 'wasmer-host-fs-test-'));
  const root = join(directory, 'mounted');
  fs.mkdirSync(root);
  const owner = {};
  const owners = new Set([owner]);
  t.after(() => {
    try {
      for (const current of owners) closeHostMounts(current);
      assert.deepEqual(hostFileSystemStats(), baseline, 'mounts and descriptors must be released');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  function register(configs = [{ hostPath: root, guestPath: '/mounted' }], current = owner) {
    owners.add(current);
    return registerHostMounts(current, configs);
  }
  return { directory, root, owner, register };
}

function rpc(lease) {
  const id = lease.mounts[0].id;
  return (method, ...args) => dispatchHostFileSystem(id, method, args);
}

function open(call, path, options = {}) {
  const { read = true, write = false, create = false, exclusive = false, truncate = false, append = false } = options;
  return call('open', path, read, write, create, exclusive, truncate, append);
}

test('mount reads current host contents and writes through with filesystem metadata', (t) => {
  const { root, register } = fixture(t);
  fs.writeFileSync(join(root, 'hello.txt'), 'initial');
  const call = rpc(register());
  fs.writeFileSync(join(root, 'hello.txt'), 'latest host content');
  const file = open(call, 'hello.txt', { write: true });
  assert.equal(call('read', file, 0, 100).toString(), 'latest host content');
  assert.equal(call('write', file, 0, Buffer.from('LATEST')), 6);
  assert.equal(fs.readFileSync(join(root, 'hello.txt'), 'utf8'), 'LATEST host content');

  const metadata = call('fileStat', file);
  assert.equal(metadata.kind, 'file');
  assert.equal(metadata.size, 19);
  for (const key of ['accessed', 'modified', 'created']) assert.match(metadata[key], /^\d+$/);
  assert.equal(call('stat', '').kind, 'directory');
  assert.deepEqual(call('readDir', '').map(({ name, kind }) => [name, kind]), [['hello.txt', 'file']]);
  call('flush', file);
  assert.equal(call('sync'), null);
  assert.equal(dispatchHostFileSystem(register().mounts[0].id, 'sync', null), null);
  call('close', file);
});

test('creates directories and files, renames and removes them on the host', (t) => {
  const { root, register } = fixture(t);
  const call = rpc(register());
  call('mkdir', 'nested');
  const file = open(call, 'nested/new.txt', { write: true, create: true, exclusive: true });
  call('write', file, 0, Buffer.from('persisted'));
  call('close', file);
  assert.throws(() => open(call, 'nested/new.txt', { write: true, exclusive: true }), { code: 'EEXIST' });
  call('rename', 'nested/new.txt', 'nested/renamed.txt');
  assert.equal(fs.readFileSync(join(root, 'nested/renamed.txt'), 'utf8'), 'persisted');
  assert.equal(fs.existsSync(join(root, 'nested/new.txt')), false);
  assert.throws(() => call('remove', 'nested'), { code: 'ENOTEMPTY' });
  call('remove', 'nested/renamed.txt');
  call('remove', 'nested');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('binary I/O respects offsets, append semantics, truncation and EOF', (t) => {
  const { root, register } = fixture(t);
  const call = rpc(register());
  const file = open(call, 'bytes.bin', { write: true, create: true });
  const bytes = Buffer.alloc(64 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  assert.equal(call('write', file, 0, bytes), bytes.length);
  assert.deepEqual(call('read', file, 17, 256), bytes.subarray(17, 273));
  assert.equal(call('read', file, bytes.length, 1).length, 0);
  call('setLen', file, 4);
  call('close', file);
  // WASIX expresses append permission independently of its write flag.
  const append = open(call, 'bytes.bin', { append: true });
  call('write', append, 0, Buffer.from([254, 255]));
  assert.deepEqual(fs.readFileSync(join(root, 'bytes.bin')), Buffer.from([0, 1, 2, 3, 254, 255]));
  call('close', append);
  // A Windows native append handle may not have FILE_WRITE_DATA for resizing.
  const resize = open(call, 'bytes.bin', { write: true });
  call('setLen', resize, 8);
  assert.deepEqual(call('read', resize, 4, 8), Buffer.from([254, 255, 0, 0]));
  call('close', resize);
  const truncated = open(call, 'bytes.bin', { write: true, truncate: true });
  assert.equal(call('fileStat', truncated).size, 0);
  call('close', truncated);
  const appendOnly = call('open', 'append-only.bin', false, false, true, false, false, true);
  call('write', appendOnly, 0, Buffer.from([1, 2]));
  call('write', appendOnly, 0, Buffer.from([3]));
  assert.throws(() => call('read', appendOnly, 0, 3), { code: 'EPERM' });
  assert.deepEqual(fs.readFileSync(join(root, 'append-only.bin')), Buffer.from([1, 2, 3]));
  call('close', appendOnly);
});

test('truncating an append handle preserves the native host result', (t) => {
  const { root, register } = fixture(t);
  fs.writeFileSync(join(root, 'native.txt'), 'original');
  fs.writeFileSync(join(root, 'mounted.txt'), 'original');
  const fd = fs.openSync(join(root, 'native.txt'), 'a+');
  let nativeError;
  try { fs.ftruncateSync(fd, 2); }
  catch (error) { nativeError = error; }
  finally { fs.closeSync(fd); }
  const call = rpc(register());
  const file = open(call, 'mounted.txt', { append: true });
  if (nativeError) assert.throws(() => call('setLen', file, 2), { code: nativeError.code });
  else call('setLen', file, 2);
  call('close', file);
  assert.deepEqual(fs.readFileSync(join(root, 'mounted.txt')), fs.readFileSync(join(root, 'native.txt')));
});

test('path and descriptor timestamps preserve unspecified fields', (t) => {
  const { root, register } = fixture(t);
  fs.writeFileSync(join(root, 'time.txt'), 'clock');
  const call = rpc(register());
  // Opening can refresh host access time; set the controlled timestamps after it.
  const file = open(call, 'time.txt', { write: true });
  const atime = '1700000000000000000';
  const mtime = '1700000100000000000';
  call('setTimes', 'time.txt', atime, mtime);
  let stats = fs.statSync(join(root, 'time.txt'), { bigint: true });
  assert.equal(stats.atimeNs.toString(), atime);
  assert.equal(stats.mtimeNs.toString(), mtime);
  call('setFileTimes', file, null, '1700000200000000000');
  stats = fs.statSync(join(root, 'time.txt'), { bigint: true });
  assert.equal(stats.atimeNs.toString(), atime);
  assert.equal(stats.mtimeNs.toString(), '1700000200000000000');
  assert.throws(() => call('setTimes', 'time.txt', 'not a timestamp', null), { code: 'EINVAL' });
});

test('read-only mounts reject mutation through paths and descriptors', (t) => {
  const { root, register } = fixture(t);
  fs.writeFileSync(join(root, 'original.txt'), 'unchanged');
  const call = rpc(register([{ hostPath: root, guestPath: '/readonly', readOnly: true }]));
  const file = open(call, 'original.txt');
  assert.equal(call('read', file, 0, 100).toString(), 'unchanged');
  const attempts = [
    () => open(call, 'original.txt', { write: true, truncate: true }),
    () => open(call, 'new.txt', { write: true, create: true }),
    () => open(call, 'original.txt', { append: true }),
    () => call('write', file, 0, Buffer.from('changed')),
    () => call('setLen', file, 0),
    () => call('setFileTimes', file, '1700000000000000000', null),
    () => call('setTimes', 'original.txt', null, '1700000000000000000'),
    () => call('mkdir', 'new-directory'),
    () => call('rename', 'original.txt', 'renamed.txt'),
    () => call('remove', 'original.txt'),
  ];
  for (const attempt of attempts) assert.throws(attempt, { code: 'EPERM' });
  assert.equal(fs.readFileSync(join(root, 'original.txt'), 'utf8'), 'unchanged');
  assert.deepEqual(fs.readdirSync(root), ['original.txt']);
});

test('metadata represents pre-epoch timestamps as unsigned WASIX values', (t) => {
  const { root, register } = fixture(t);
  const path = join(root, 'old.txt');
  fs.writeFileSync(path, 'old');
  try {
    fs.utimesSync(path, new Date(-10_000), new Date(-20_000));
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) return t.skip('Host filesystem does not accept pre-epoch timestamps');
    throw error;
  }
  const stats = fs.statSync(path, { bigint: true });
  if (stats.atimeNs >= 0n || stats.mtimeNs >= 0n) return t.skip('Host filesystem clamps pre-epoch timestamps itself');
  const call = rpc(register());
  assert.equal(call('stat', 'old.txt').accessed, '0');
  assert.equal(call('stat', 'old.txt').modified, '0');
  const file = open(call, 'old.txt');
  assert.equal(call('fileStat', file).modified, '0');
});

test('file descriptors enforce read and write permissions on writable mounts', (t) => {
  const { root, register } = fixture(t);
  fs.writeFileSync(join(root, 'data.txt'), 'original');
  const call = rpc(register());
  const reader = open(call, 'data.txt');
  const writer = open(call, 'data.txt', { read: false, write: true });
  assert.throws(() => call('write', reader, 0, Buffer.from('bad')), { code: 'EPERM' });
  assert.throws(() => call('setLen', reader, 0), { code: 'EPERM' });
  assert.throws(() => call('setFileTimes', reader, '1700000000000000000', null), { code: 'EPERM' });
  assert.throws(() => call('read', writer, 0, 10), { code: 'EPERM' });
  assert.equal(fs.readFileSync(join(root, 'data.txt'), 'utf8'), 'original');
});

test('rejects path traversal, absolute paths and removal or rename of the mount root', (t) => {
  const { directory, root, register } = fixture(t);
  const outside = join(directory, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  const call = rpc(register());
  for (const path of ['../outside.txt', 'nested/../../outside.txt', outside, 'folder\\outside.txt', 'bad\0path']) {
    assert.throws(() => call('stat', path), { code: 'EPERM' });
    assert.throws(() => open(call, path, { write: true, create: true, truncate: true }), { code: 'EPERM' });
  }
  for (const path of ['', '.', './']) {
    assert.throws(() => call('remove', path), { code: 'EPERM' });
    assert.throws(() => call('rename', path, 'new-root'), { code: 'EPERM' });
  }
  assert.throws(() => open(call, ''), { code: 'EISDIR' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.ok(fs.statSync(root).isDirectory());
});

test('rejects final and intermediate symlinks before reading or truncating targets', (t) => {
  const { directory, root, register } = fixture(t);
  fs.mkdirSync(join(directory, 'outside'));
  const target = join(directory, 'outside/secret.txt');
  fs.writeFileSync(target, 'keep secret');
  try {
    fs.symlinkSync(target, join(root, 'file-link'), 'file');
    fs.symlinkSync(join(directory, 'outside'), join(root, 'directory-link'), 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Creating symlinks requires Windows privileges or Developer Mode');
    throw error;
  }
  const call = rpc(register());
  for (const path of ['file-link', 'directory-link/secret.txt']) {
    assert.throws(() => call('stat', path), { code: 'EPERM' });
    assert.throws(() => open(call, path), { code: 'EPERM' });
    assert.throws(() => open(call, path, { write: true, truncate: true }), { code: 'EPERM' });
    assert.throws(() => call('remove', path), { code: 'EPERM' });
  }
  assert.throws(() => open(call, 'directory-link/new.txt', { write: true, create: true }), { code: 'EPERM' });
  assert.throws(() => call('readDir', ''), { code: 'EPERM' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep secret');
  assert.equal(fs.existsSync(join(directory, 'outside/new.txt')), false);
});

test('rejects existing hardlinks and revalidates handles if a file becomes hardlinked', (t) => {
  const { directory, root, register } = fixture(t);
  const target = join(directory, 'outside.txt');
  fs.writeFileSync(target, 'outside');
  fs.linkSync(target, join(root, 'hardlink.txt'));
  fs.writeFileSync(join(root, 'regular.txt'), 'original');
  const call = rpc(register());
  assert.throws(() => open(call, 'hardlink.txt', { write: true, truncate: true }), { code: 'EPERM' });
  assert.throws(() => call('stat', 'hardlink.txt'), { code: 'EPERM' });
  const file = open(call, 'regular.txt', { write: true });
  fs.linkSync(join(root, 'regular.txt'), join(directory, 'added-link.txt'));
  assert.throws(() => call('read', file, 0, 100), { code: 'EPERM' });
  assert.throws(() => call('write', file, 0, Buffer.from('bad')), { code: 'EPERM' });
  assert.throws(() => call('setLen', file, 0), { code: 'EPERM' });
  call('close', file);
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside');
  assert.equal(fs.readFileSync(join(directory, 'added-link.txt'), 'utf8'), 'original');
});

test('replacing the mount root revokes path and open-handle operations', (t) => {
  const { directory, root, register } = fixture(t);
  fs.writeFileSync(join(root, 'data.txt'), 'original');
  const lease = register();
  const call = rpc(lease);
  const file = open(call, 'data.txt', { write: true });
  const moved = join(directory, 'old-root');
  // Windows locks directories containing open files. Move the file first while
  // keeping its descriptor open, then replace the registered mount root.
  const movedFile = join(directory, 'opened.txt');
  fs.renameSync(join(root, 'data.txt'), movedFile);
  fs.renameSync(root, moved);
  fs.mkdirSync(root);
  fs.writeFileSync(join(root, 'data.txt'), 'replacement');
  assert.throws(() => call('stat', 'data.txt'), { code: 'EPERM' });
  assert.throws(() => call('write', file, 0, Buffer.from('bad')), { code: 'EPERM' });
  assert.throws(() => call('read', file, 0, 100), { code: 'EPERM' });
  const handlesBeforeClose = hostFileSystemStats().handles;
  assert.equal(call('close', file), null, 'root replacement must not prevent closing an existing descriptor');
  assert.equal(hostFileSystemStats().handles, handlesBeforeClose - 1);
  lease.close();
  assert.equal(fs.readFileSync(movedFile, 'utf8'), 'original');
  assert.equal(fs.readFileSync(join(root, 'data.txt'), 'utf8'), 'replacement');
});

test('registration validates configuration and rolls back partial directory registrations', (t) => {
  const { directory, root, register } = fixture(t);
  const baseline = hostFileSystemStats();
  fs.writeFileSync(join(directory, 'not-directory'), 'file');
  for (const second of ['missing', 'not-directory']) {
    assert.throws(() => register([
      { hostPath: root, guestPath: '/first' },
      { hostPath: join(directory, second), guestPath: '/second' },
    ]), { code: second === 'missing' ? 'ENOENT' : 'ENOTDIR' });
    assert.deepEqual(hostFileSystemStats(), baseline);
  }
  const invalid = [
    null,
    [{ hostPath: 'relative', guestPath: '/mounted' }],
    [{ hostPath: root, guestPath: '/' }],
    [{ hostPath: root, guestPath: '/mounted/../escape' }],
    [{ hostPath: root, guestPath: '/workspace/data' }],
    [{ hostPath: root, guestPath: '/tmp' }],
    [{ hostPath: root, guestPath: '/mounted', readOnly: 'yes' }],
    [{ hostPath: root, guestPath: '/mount' }, { hostPath: root, guestPath: '/mount/nested' }],
  ];
  for (const configs of invalid) {
    assert.throws(() => register(configs), { code: 'EINVAL' });
    assert.deepEqual(hostFileSystemStats(), baseline);
  }
});

test('owner and lease cleanup release only their mounts and reject late RPCs', (t) => {
  const { root, owner, register } = fixture(t);
  fs.writeFileSync(join(root, 'data.txt'), 'available');
  const baseline = hostFileSystemStats();
  const first = register();
  const second = register([{ hostPath: root, guestPath: '/another' }]);
  const independent = register([{ hostPath: root, guestPath: '/independent' }], {});
  const firstCall = rpc(first);
  const secondCall = rpc(second);
  const independentCall = rpc(independent);
  open(firstCall, 'data.txt');
  open(secondCall, 'data.txt');
  const independentFile = open(independentCall, 'data.txt');
  assert.deepEqual(hostFileSystemStats(), { mounts: baseline.mounts + 3, handles: baseline.handles + 3 });
  first.close();
  first.close();
  assert.throws(() => firstCall('stat', ''), { code: 'EPERM' });
  assert.equal(secondCall('stat', 'data.txt').size, 9);
  closeHostMounts(owner);
  closeHostMounts(owner);
  assert.throws(() => secondCall('stat', ''), { code: 'EPERM' });
  assert.deepEqual(hostFileSystemStats(), { mounts: baseline.mounts + 1, handles: baseline.handles + 1 });
  assert.equal(independentCall('read', independentFile, 0, 100).toString(), 'available');
  const replacement = register();
  assert.notEqual(replacement.mounts[0].id, first.mounts[0].id, 'retired mount IDs must not be reused');
  assert.throws(() => firstCall('stat', ''), { code: 'EPERM' });
});

test('lease and owner cleanup close their native file descriptors', (t) => {
  const { root, owner, register } = fixture(t);
  const path = join(root, 'data.txt');
  fs.writeFileSync(path, 'available');
  const target = fs.statSync(path, { bigint: true });
  const first = register();
  const second = register([{ hostPath: root, guestPath: '/another' }]);
  const originalOpen = nativeFs.openSync;
  const descriptors = [];
  const mockedOpen = t.mock.method(nativeFs, 'openSync', (...args) => {
    const fd = originalOpen(...args);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev === target.dev && opened.ino === target.ino) descriptors.push(fd);
    return fd;
  });
  try {
    // The adapter imports the ESM namespace; update its binding to the scoped mock.
    syncBuiltinESMExports();
    open(rpc(first), 'data.txt');
    open(rpc(second), 'data.txt');
    assert.equal(descriptors.length, 2);
    for (const fd of descriptors) assert.ok(fs.fstatSync(fd).isFile());

    first.close();
    assert.throws(() => fs.fstatSync(descriptors[0]), { code: 'EBADF' });
    assert.ok(fs.fstatSync(descriptors[1]).isFile(), 'closing one lease preserves the other descriptor');

    closeHostMounts(owner);
    assert.throws(() => fs.fstatSync(descriptors[1]), { code: 'EBADF' });
  } finally {
    mockedOpen.mock.restore();
    syncBuiltinESMExports();
  }
});

test('malformed operations and stale descriptors fail without leaking handles', (t) => {
  const { root, register } = fixture(t);
  fs.writeFileSync(join(root, 'data.txt'), 'data');
  const lease = register();
  const call = rpc(lease);
  const file = open(call, 'data.txt', { write: true });
  assert.throws(() => call('unknown-operation'), { code: 'ENOTSUP' });
  assert.throws(() => call('stat'), { code: 'EINVAL' });
  assert.throws(() => dispatchHostFileSystem(lease.mounts[0].id, 'stat', 'data.txt'), { code: 'EINVAL' });
  assert.throws(() => dispatchHostFileSystem(-1, 'stat', ['']), { code: 'EINVAL' });
  assert.throws(() => call('read', file, -1, 4), { code: 'EINVAL' });
  assert.throws(() => call('read', file, 0, 64 * 1024 + 1), { code: 'EINVAL' });
  assert.throws(() => call('write', file, 0, Buffer.alloc(64 * 1024 + 1)), { code: 'EINVAL' });
  assert.throws(() => call('write', file, 0, [1, 2, 3]), { code: 'EINVAL' });
  assert.throws(() => call('setLen', file, NaN), { code: 'EINVAL' });
  assert.throws(() => call('open', 'data.txt', false, false, false, false, false, false), { code: 'EINVAL' });
  assert.throws(() => open(call, 'data.txt', { truncate: true }), { code: 'EINVAL' });
  assert.throws(() => call('read', 0, 0, 4), { code: 'EBADF' });
  assert.throws(() => call('close', 0xffff_ffff), { code: 'EBADF' });
  call('close', file);
  assert.equal(call('close', file), null, 'Rust explicit close followed by Drop is harmless');
  assert.throws(() => call('read', file, 0, 4), { code: 'EBADF' });
  assert.throws(() => call('write', file, 0, Buffer.from('bad')), { code: 'EBADF' });
  assert.equal(fs.readFileSync(join(root, 'data.txt'), 'utf8'), 'data');
});
