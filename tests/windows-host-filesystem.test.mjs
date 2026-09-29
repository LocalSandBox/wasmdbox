import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { hostRelativePathParts, registerHostMounts, dispatchHostFileSystem, hostFileSystemStats } from '../dist/internal/node-host-filesystem.js';

test('Windows guest path policy rejects devices, streams and ambiguous aliases before I/O', () => {
  for (const path of [
    '../secret', 'nested/../../secret', '/absolute', 'C:/secret', 'C:secret',
    '//server/share', '\\\\server\\share', '\\\\?\\C:\\secret', '\\\\.\\NUL', 'nested\\secret',
    'file:stream', 'file::$DATA', 'dir:name/file', 'bad\0name', 'bad\x01name',
    'bad<name', 'bad>name', 'bad"name', 'bad|name', 'bad?name', 'bad*name',
    'file.', 'file ', '.. ', 'nested./file', 'nested /file',
    'NUL', 'nul.txt', 'NUL .txt', 'CON', 'con.log', 'PRN', 'AUX',
    'COM1', 'com9.txt', 'LPT1', 'lpt9.log', 'COM¹', 'LPT².txt', 'COM³.log',
    'CONIN$', 'CONOUT$.txt', 'nested/NUL.txt',
  ]) assert.throws(() => hostRelativePathParts(path, true), { code: 'EPERM' }, path);
  for (const path of ['', '.', './', '数据 空格/hello.txt', '.git/config', 'a..b', 'COM10.txt', 'console.txt']) {
    assert.ok(Array.isArray(hostRelativePathParts(path, true)), path);
  }
  assert.deepEqual(hostRelativePathParts('./数据 空格//hello.txt', true), ['数据 空格', 'hello.txt']);
  for (const name of ['NUL', 'file:stream', 'file.', 'file ', 'bad?name']) {
    assert.deepEqual(hostRelativePathParts(name, false), [name], 'POSIX names retain their existing meaning');
  }
});

// The open/check algorithm is exercised everywhere. These tests do not claim
// to emulate Windows filesystem semantics; the native tests and Windows CI do.
function fixture(t, simulateWindows = false) {
  if (simulateWindows && process.platform !== 'win32') {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
  }
  const directory = fs.mkdtempSync(join(tmpdir(), 'wasmdbox-windows-'));
  const root = join(directory, '数据 空格');
  fs.mkdirSync(root);
  const baseline = hostFileSystemStats();
  const lease = registerHostMounts({}, [{ hostPath: root, guestPath: '/mounted' }]);
  const call = (method, ...args) => dispatchHostFileSystem(lease.mounts[0].id, method, args);
  t.after(() => {
    lease.close();
    assert.deepEqual(hostFileSystemStats(), baseline);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root: fs.realpathSync.native(root), call };
}

function open(call, name, create = false, truncate = false) {
  return call('open', name, true, true, create, false, truncate, false);
}

function mockOpen(t, implementation) {
  const original = fs.openSync;
  const mocked = t.mock.method(fs, 'openSync', (...args) => implementation(original, args));
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

test('Windows adapter reads and writes ordinary Unicode paths with native descriptors', t => {
  const { root, call } = fixture(t, true);
  call('mkdir', '子目录');
  const file = open(call, '子目录/hello world.txt', true);
  call('write', file, 0, Buffer.from('hello'));
  assert.equal(call('read', file, 1, 3).toString(), 'ell');
  call('close', file);
  assert.deepEqual(call('readDir', '子目录').map(entry => entry.name), ['hello world.txt']);
  assert.equal(fs.readFileSync(join(root, '子目录/hello world.txt'), 'utf8'), 'hello');
});

test('Windows open rejects replacement before truncation and closes the rejected descriptor', t => {
  const { root, call } = fixture(t, true);
  const path = join(root, 'data.txt');
  fs.writeFileSync(path, 'original');
  let opened;
  mockOpen(t, (original, args) => {
    if (args[0] === path) {
      fs.renameSync(path, join(root, 'old.txt'));
      fs.writeFileSync(path, 'replacement');
      opened = original(...args);
      return opened;
    }
    return original(...args);
  });
  assert.throws(() => open(call, 'data.txt', false, true), { code: 'EPERM' });
  assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
  assert.equal(fs.readFileSync(path, 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(join(root, 'old.txt'), 'utf8'), 'original');
});

test('Windows create uses exclusive creation when the checked file was absent', t => {
  const { root, call } = fixture(t, true);
  const path = join(root, 'new.txt');
  mockOpen(t, (original, args) => {
    if (args[0] === path) {
      assert.ok(args[1] & fs.constants.O_EXCL);
      // Simulate another process creating the file after validation.
      fs.writeFileSync(path, 'concurrent creator');
    }
    return original(...args);
  });
  assert.throws(() => open(call, 'new.txt', true, true), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path, 'utf8'), 'concurrent creator');
});

test('Windows open rejects a path replaced after the native descriptor was opened', t => {
  const { root, call } = fixture(t, true);
  const path = join(root, 'data.txt');
  fs.writeFileSync(path, 'original');
  let opened;
  mockOpen(t, (original, args) => {
    const fd = original(...args);
    if (args[0] === path) {
      opened = fd;
      fs.renameSync(path, join(root, 'old.txt'));
      fs.writeFileSync(path, 'replacement');
    }
    return fd;
  });
  assert.throws(() => open(call, 'data.txt', false, true), { code: 'EPERM' });
  assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
  assert.equal(fs.readFileSync(path, 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(join(root, 'old.txt'), 'utf8'), 'original');
});

test('Windows canonical containment rejects paths resolving outside the root', t => {
  const { directory, root, call } = fixture(t, true);
  const path = join(root, 'data.txt');
  fs.writeFileSync(path, 'original');
  const realpath = fs.realpathSync.native;
  const mocked = t.mock.method(fs.realpathSync, 'native', (...args) => args[0] === path ? join(directory, 'outside.txt') : realpath(...args));
  t.after(() => mocked.mock.restore());
  assert.throws(() => call('stat', 'data.txt'), { code: 'EPERM' });
  assert.throws(() => open(call, 'data.txt', false, true), { code: 'EPERM' });
  assert.equal(fs.readFileSync(path, 'utf8'), 'original');
});

test('Windows existing-file open does not request creation or early truncation', t => {
  const { root, call } = fixture(t, true);
  const path = join(root, 'data.txt');
  fs.writeFileSync(path, 'original');
  mockOpen(t, (original, args) => {
    if (args[0] === path) {
      assert.equal(args[1] & (fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK), 0);
      assert.equal(fs.readFileSync(path, 'utf8'), 'original');
    }
    return original(...args);
  });
  const file = open(call, 'data.txt', true, true);
  call('close', file);
  assert.equal(fs.statSync(path).size, 0);
});

test('native Windows junctions cannot escape a writable mount', { skip: process.platform !== 'win32' }, t => {
  const { directory, root, call } = fixture(t);
  const outside = join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'secret.txt'), 'outside secret');
  fs.symlinkSync(outside, join(root, 'junction'), 'junction');
  for (const name of ['junction', 'junction/secret.txt']) {
    assert.throws(() => call('stat', name), { code: 'EPERM' });
    assert.throws(() => open(call, name, true, true), { code: 'EPERM' });
    assert.throws(() => call('remove', name), { code: 'EPERM' });
  }
  assert.throws(() => open(call, 'junction/new.txt', true), { code: 'EPERM' });
  assert.throws(() => call('mkdir', 'junction/new-directory'), { code: 'EPERM' });
  fs.writeFileSync(join(root, 'safe.txt'), 'safe');
  assert.throws(() => call('rename', 'safe.txt', 'junction/moved.txt'), { code: 'EPERM' });
  assert.equal(fs.readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside secret');
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
});

test('native Windows rejects alternate data streams and preserves hidden file writes', { skip: process.platform !== 'win32' }, t => {
  const { root, call } = fixture(t);
  const path = join(root, 'hidden.txt');
  fs.writeFileSync(path, 'original');
  fs.writeFileSync(path + ':private', 'private stream');
  for (const name of ['hidden.txt:private', 'hidden.txt::$DATA']) {
    assert.throws(() => call('stat', name), { code: 'EPERM' });
    assert.throws(() => open(call, name, true, true), { code: 'EPERM' });
  }
  execFileSync('attrib.exe', ['+H', path]);
  try {
    const file = open(call, 'hidden.txt', true, true);
    call('write', file, 0, Buffer.from('updated'));
    call('close', file);
    assert.equal(fs.readFileSync(path, 'utf8'), 'updated');
    assert.equal(fs.readFileSync(path + ':private', 'utf8'), 'private stream');
  } finally { execFileSync('attrib.exe', ['-H', path]); }
});

test('native Windows resolves host root casing before checking containment', { skip: process.platform !== 'win32' }, t => {
  const { root } = fixture(t);
  fs.writeFileSync(join(root, 'data.txt'), 'case-insensitive root');
  const lease = registerHostMounts({}, [{ hostPath: root.toUpperCase(), guestPath: '/mounted' }]);
  try {
    const id = lease.mounts[0].id;
    const file = dispatchHostFileSystem(id, 'open', ['data.txt', true, false, false, false, false, false]);
    assert.equal(dispatchHostFileSystem(id, 'read', [file, 0, 100]).toString(), 'case-insensitive root');
    dispatchHostFileSystem(id, 'close', [file]);
  } finally { lease.close(); }
});
