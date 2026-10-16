import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link, stat, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Sandbox } from 'wasmdbox';

const node = script => ['node', '-e', script];

// Each platform probe owns its files and sandbox. Command deadlines make hangs
// failures; even documented limitations must preserve data and allow reuse.
async function platformWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'wasmdbox-platform-'));
  let box;
  let releaseLock;
  t.after(async () => {
    try { if (box) await box.close(); }
    finally {
      try { await releaseLock?.(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  return {
    root,
    async lockFile(path) {
      releaseLock = await lockWindowsFile(path);
      return releaseLock;
    },
    async create() {
      box = await Sandbox.create({ network: false, startupTimeoutMs: 45_000, signal: t.signal,
        mounts: [{ hostPath: root, guestPath: '/workspace' }],
      });
      return (argv, options = {}) => box.exec(argv, {
        timeoutMs: 20_000, signal: t.signal, check: true, ...options,
      });
    },
  };
}

async function caseInsensitiveVolume(root) {
  const probe = join(root, 'case-probe');
  await writeFile(probe, 'probe');
  try {
    const original = await stat(probe);
    const alias = await stat(join(root, 'CASE-PROBE'));
    return original.dev === alias.dev && original.ino === alias.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally { await rm(probe); }
}

async function assertWorkspaceUsable(exec) {
  assert.equal((await exec(['bash', '-c', 'pwd; printf usable'])).stdout, '/workspace\nusable');
}

// FileShare.None denies deletion as well as reads/writes. Wait for an explicit
// handshake, not a sleep, and release the process before removing its fixture.
async function lockWindowsFile(path) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $file = [System.IO.File]::Open($env:WASMDBOX_LOCK_PATH, 'Open', 'ReadWrite', 'None')
    try {
      [Console]::Out.WriteLine('locked')
      [Console]::Out.Flush()
      [Console]::In.ReadLine() | Out-Null
    } finally { $file.Dispose() }
  `], { env: { ...process.env, WASMDBOX_LOCK_PATH: path }, windowsHide: true, timeout: 60_000 });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {}); // The cleanup write can race with process exit.
  const closed = new Promise(resolve => child.once('close', resolve));
  let releasing;
  const release = () => releasing ??= (async () => {
    const timer = setTimeout(() => child.kill(), 5_000);
    try { child.stdin.end('\n'); await closed; }
    finally { clearTimeout(timer); }
  })();
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => finish(new Error(`File lock handshake timed out: ${stderr}`)), 15_000);
      const finish = error => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('close', onClose);
        if (error) reject(error); else resolve();
      };
      const onData = chunk => {
        output += chunk;
        if (output.includes('locked\n') || output.includes('locked\r\n')) finish();
      };
      const onError = error => finish(error);
      const onClose = code => finish(new Error(`File lock process exited before handshake (${code}): ${stderr}`));
      child.stdout.setEncoding('utf8').on('data', onData);
      child.once('error', onError);
      child.once('close', onClose);
    });
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

test('host-backed workspace platform behavior', { timeout: 300_000 }, async t => {
  await t.test('case-only rename preserves the file and its contents', { timeout: 90_000 }, async t => {
    const { root, create } = await platformWorkspace(t);
    if (!await caseInsensitiveVolume(root)) return t.skip('Temporary volume is case-sensitive');
    await writeFile(join(root, 'readme.md'), 'hello');
    const exec = await create();
    assert.equal((await exec(['bash', '-c', 'mv readme.md README.md && cat README.md'])).stdout, 'hello');
    assert.deepEqual(await readdir(root), ['README.md']);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'hello');
    await assertWorkspaceUsable(exec);
  });

  await t.test('case aliases share one host file; subsequent commands list it once', { timeout: 90_000 }, async t => {
    const { root, create } = await platformWorkspace(t);
    if (!await caseInsensitiveVolume(root)) return t.skip('Temporary volume is case-sensitive');
    const exec = await create();
    const result = await exec(['bash', '-c', 'echo a > Foo && echo b > foo && ls -1']);
    assert.deepEqual(await readdir(root), ['Foo']);
    assert.equal(await readFile(join(root, 'Foo'), 'utf8'), 'b\n');
    const names = result.stdout.trim().split('\n').sort();
    // Wasmer can retain both guest spellings within one command. Only this
    // exact display limitation is allowed; no lost files or stale contents.
    if (names.length === 2) {
      assert.deepEqual(names, ['Foo', 'foo']);
      t.diagnostic('Known limitation: same-command enumeration includes both case aliases');
    } else assert.deepEqual(names, ['Foo']);
    assert.equal((await exec(['bash', '-c', 'ls -1; cat Foo; cat foo'])).stdout, 'Foo\nb\nb\n');
    await assertWorkspaceUsable(exec);
  });

  for (const name of ['aux.txt', 'a.']) {
    await t.test(`Windows rejects ${name} without writing an alias`, {
      skip: process.platform !== 'win32', timeout: 90_000,
    }, async t => {
      const { root, create } = await platformWorkspace(t);
      await writeFile(join(root, 'a'), 'original');
      const exec = await create();
      const result = await exec(['bash', '-c', `echo x > '${name}'`], { check: false });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /EPERM|EACCES|permission denied|operation not permitted|access.*denied/i);
      assert.equal(result.stderr.includes(root), false, 'guest errors do not expose the host path');
      assert.deepEqual(await readdir(root), ['a']);
      assert.equal(await readFile(join(root, 'a'), 'utf8'), 'original');
      await assertWorkspaceUsable(exec);
    });
  }

  await t.test('Windows exclusive host handle prevents guest deletion without breaking reuse', {
    skip: process.platform !== 'win32', timeout: 90_000,
  }, async t => {
    const { root, create, lockFile } = await platformWorkspace(t);
    const path = join(root, 'x.txt');
    await writeFile(path, 'locked content');
    const exec = await create();
    const release = await lockFile(path);
    try {
      await assert.rejects(rm(path), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code),
        'native host deletion must confirm that the exclusive handle blocks removal');
      const result = await exec(['bash', '-c', 'rm x.txt'], { check: false });
      assert.notEqual(result.exitCode, 0);
      // The Windows sharing violation can lose its specific errno in WASIX.
      // Accept only this observed diagnostic after independently proving the lock.
      if (/^rm: cannot remove 'x\.txt': I\/O error\r?\n?$/.test(result.stderr)) {
        t.diagnostic('Known limitation: the guest reports the Windows sharing violation as I/O error');
      } else {
        assert.match(result.stderr, /EBUSY|EPERM|EACCES|permission denied|operation not permitted|resource busy|access.*denied/i);
      }
      assert.deepEqual(await readdir(root), ['x.txt']);
      await assertWorkspaceUsable(exec);
    } finally { await release(); }
    assert.equal(await readFile(path, 'utf8'), 'locked content');
    assert.equal((await exec(['bash', '-c', 'cat x.txt && rm x.txt'])).stdout, 'locked content');
    assert.deepEqual(await readdir(root), []);
    await assertWorkspaceUsable(exec);
  });

  await t.test('Windows long paths persist or report ENAMETOOLONG explicitly', {
    skip: process.platform !== 'win32', timeout: 90_000,
  }, async t => {
    const { root, create } = await platformWorkspace(t);
    await writeFile(join(root, 'sentinel.txt'), 'preserved');
    const segments = Array.from({ length: 7 }, (_, i) => `segment-${i}-${'x'.repeat(40)}`);
    const directory = segments.join('/');
    const target = directory + '/result.txt';
    assert.ok(join(root, target).length > 260);
    const exec = await create();
    const result = await exec(node(`const fs = require('node:fs');
      try {
        fs.mkdirSync(${JSON.stringify(directory)}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(target)}, 'long path content');
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.code, message: error.message }));
        process.exitCode = 1;
      }`), { check: false });
    const outcome = JSON.parse(result.stdout);
    if (result.exitCode === 0) {
      assert.deepEqual(outcome, { ok: true });
      assert.equal(await readFile(join(root, target), 'utf8'), 'long path content');
    } else {
      assert.equal(result.exitCode, 1);
      assert.equal(outcome.code, 'ENAMETOOLONG');
      assert.equal(typeof outcome.message, 'string');
      assert.ok(outcome.message.length > 0);
      t.diagnostic('Known limitation: host/runtime rejected a path longer than 260 characters');
    }
    const allowed = new Set(['sentinel.txt', ...segments.map((_, i) => segments.slice(0, i + 1).join('/'))]);
    if (result.exitCode === 0) allowed.add(target);
    for (const entry of await readdir(root, { recursive: true })) {
      assert.ok(allowed.has(entry.split(sep).join('/')), `Unexpected or truncated path: ${entry}`);
    }
    assert.equal(await readFile(join(root, 'sentinel.txt'), 'utf8'), 'preserved');
    await assertWorkspaceUsable(exec);
  });

  await t.test('macOS NFC lookup of a host NFD filename preserves its contents', {
    skip: process.platform !== 'darwin', timeout: 90_000,
  }, async t => {
    const { root, create } = await platformWorkspace(t);
    const nfd = 'café.txt'.normalize('NFD');
    await writeFile(join(root, nfd), 'unicode content');
    const before = await readdir(root);
    const exec = await create();
    const result = await exec(['bash', '-c', "cat 'café.txt'"], { check: false });
    if (result.exitCode === 0) assert.equal(result.stdout, 'unicode content');
    else {
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /ENOENT|no such file or directory/i);
      t.diagnostic('Known limitation: this volume/runtime requires the original Unicode filename normalization');
    }
    assert.deepEqual(await readdir(root), before);
    assert.equal(await readFile(join(root, nfd), 'utf8'), 'unicode content');
    assert.equal((await exec(['cat', `/workspace/${nfd}`])).stdout, 'unicode content');
    await assertWorkspaceUsable(exec);
  });

  await t.test('POSIX executable-mode probes record host effects, not just guest success', {
    skip: process.platform === 'win32', timeout: 90_000,
  }, async t => {
    const { root, create } = await platformWorkspace(t);
    const path = join(root, 'run.sh');
    const content = '#!/bin/sh\nprintf executable';
    await writeFile(path, content);
    await chmod(path, 0o644);
    const exec = await create();
    const shell = await exec(['bash', '-c', 'chmod +x run.sh'], { check: false });
    if (shell.exitCode === 127) {
      assert.match(shell.stderr, /chmod: command not found/);
      assert.equal((await stat(path)).mode & 0o777, 0o644);
      t.diagnostic('Known limitation: the default runtime does not include a chmod command');
    } else {
      assert.equal(shell.exitCode, 0, shell.stderr);
      const mode = (await stat(path)).mode & 0o777;
      assert.ok(mode === 0o644 || mode === 0o755);
      if (mode === 0o644) t.diagnostic('Known limitation: guest chmod did not update the host mode');
    }
    await chmod(path, 0o644);
    const result = await exec(node(`try {
      require('node:fs').chmodSync('/workspace/run.sh', 0o755);
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code })); process.exitCode = 1;
    }`), { check: false });
    const outcome = JSON.parse(result.stdout);
    const mode = (await stat(path)).mode & 0o777;
    if (result.exitCode === 0) {
      assert.deepEqual(outcome, { ok: true });
      assert.ok(mode === 0o644 || mode === 0o755);
      if (mode === 0o644) t.diagnostic('Known limitation: fs.chmodSync succeeds without persisting host permission bits');
    } else {
      assert.equal(result.exitCode, 1);
      assert.ok(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(outcome.code));
      assert.equal(mode, 0o644);
      t.diagnostic(`Guest fs.chmodSync explicitly reports unsupported operation: ${outcome.code}`);
    }
    assert.equal(await readFile(path, 'utf8'), content);
    await assertWorkspaceUsable(exec);
  });
});

test('host-backed workspace real WASM contract', { timeout: 240_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wasmdbox-workspace-'));
  const mount = { hostPath: root, guestPath: '/workspace' };
  t.after(() => rm(root, { recursive: true, force: true }));
  const create = options => Sandbox.create({ mounts: [mount], ...options });
  async function withBox(options, inspect) {
    const box = await create(options);
    try { return await inspect(box); } finally { await box.close(); }
  }

  await t.test('files persist, overwrite and create nested paths; host edits stay visible', async () => {
    await writeFile(join(root, 'hello.txt'), 'before');
    await withBox({ files: {
      '/workspace/hello.txt': 'imported',
      '/workspace/中文 空格/data.bin': new Uint8Array([0, 128, 255]),
    } }, async box => {
      assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'imported');
      await writeFile(join(root, 'hello.txt'), 'host edit');
      await box.exec(node(`const fs = require('node:fs'), assert = require('node:assert/strict');
        assert.equal(process.cwd(), '/workspace');
        assert.equal(fs.readFileSync('hello.txt', 'utf8'), 'host edit');
        assert.deepEqual([...fs.readFileSync('中文 空格/data.bin')], [0,128,255]);
        fs.appendFileSync('hello.txt', '+guest'); fs.mkdirSync('operations');
        fs.writeFileSync('operations/new', 'new'); fs.renameSync('operations/new', 'operations/renamed');
        fs.unlinkSync('operations/renamed'); fs.rmdirSync('operations');`), { check: true });
      assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'host edit+guest');
    });
    await withBox({}, async box => {
      assert.equal((await box.exec(['bash', '-c', 'cat hello.txt'], { check: true })).stdout, 'host edit+guest');
    });
  });

  await t.test('workspace and ordinary mounts support root and nested cwd, then another command', async () => {
    await mkdir(join(root, 'nested'));
    await withBox({ mounts: [mount, { ...mount, guestPath: '/mounted' }] }, async box => {
      for (const cwd of ['/workspace', '/workspace/nested', '/mounted', '/mounted/nested']) {
        const out = await box.exec(['bash', '-c', 'pwd; printf cwd-write > cwd.txt'], { cwd, check: true });
        assert.equal(out.stdout, `${cwd}\n`);
        assert.equal((await box.exec(node('console.log(process.cwd())'), { cwd, check: true })).stdout, `${cwd}\n`);
      }
      assert.equal((await box.exec(['bash', '-c', 'printf subsequent'], { check: true })).stdout, 'subsequent');
    });
    assert.equal(await readFile(join(root, 'nested/cwd.txt'), 'utf8'), 'cwd-write');
  });

  await t.test('readOnly and denyWritePaths apply to files imports and commands', async () => {
    await assert.rejects(create({ mounts: [{ ...mount, readOnly: true }], files: { '/workspace/hello.txt': 'no' } }), { code: 'CREATE_FAILED' });
    await assert.rejects(create({ mounts: [{ ...mount, denyWritePaths: ['hello.txt'] }], files: { '/workspace/hello.txt': 'no' } }), { code: 'CREATE_FAILED' });
    for (const policy of [{ readOnly: true }, { denyWritePaths: ['hello.txt'] }]) {
      await withBox({ mounts: [{ ...mount, ...policy }] }, async box => {
        await box.exec(node(`const fs = require('node:fs'), assert = require('node:assert/strict');
          assert.equal(fs.readFileSync('hello.txt', 'utf8'), 'host edit+guest');
          assert.throws(() => fs.writeFileSync('hello.txt', 'no'));
          assert.throws(() => fs.renameSync('hello.txt', 'renamed'));
          assert.throws(() => fs.unlinkSync('hello.txt'));`), { check: true });
      });
    }
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'host edit+guest');
  });

  await t.test('failed multi-file import is explicitly nontransactional and never retried', async () => {
    await writeFile(join(root, 'a-first.txt'), 'old');
    await writeFile(join(root, 'z-protected.txt'), 'protected');
    await assert.rejects(create({ mounts: [{ ...mount, denyWritePaths: ['z-protected.txt'] }], files: {
      '/workspace/a-first.txt': 'partial write', '/workspace/z-protected.txt': 'denied',
    } }), { code: 'CREATE_FAILED' });
    assert.equal(await readFile(join(root, 'a-first.txt'), 'utf8'), 'partial write');
    assert.equal(await readFile(join(root, 'z-protected.txt'), 'utf8'), 'protected');
  });

  await t.test('runtime startup and close never overwrite user files with old internal names', async () => {
    for (const directory of ['.wasmdbox', '.seawork-runtime', '.git', '.seawork']) await mkdir(join(root, directory));
    const collisions = ['.wasmdbox/ca.pem', '.seawork-runtime/bootstrap.cjs', 'guest.cjs', '.git/config', '.seawork/data'];
    for (const path of collisions) await writeFile(join(root, path), `user:${path}`);
    const before = await readdir(root);
    await withBox({}, async box => {
      await box.exec(['bash', '-c', 'printf ready'], { check: true });
    });
    assert.deepEqual(await readdir(root), before);
    for (const path of collisions) assert.equal(await readFile(join(root, path), 'utf8'), `user:${path}`);
    await withBox({ files: { '/workspace/.wasmdbox/user.txt': 'allowed' } }, async box => {
      assert.equal((await box.exec(['bash', '-c', 'cat .wasmdbox/user.txt'], { check: true })).stdout, 'allowed');
    });
  });

  await t.test('large real WASM directory enumeration grows the RPC reply and reports omitted links', async () => {
    const directory = join(root, 'large');
    await mkdir(directory);
    for (let batch = 0; batch < 40; batch++) {
      await Promise.all(Array.from({ length: 64 }, (_, index) =>
        writeFile(join(directory, `${String(batch * 64 + index).padStart(4, '0')}-${'x'.repeat(120)}`), '')));
    }
    await writeFile(join(directory, 'hard-source'), 'unsupported');
    await link(join(directory, 'hard-source'), join(directory, 'hard-link'));
    await withBox({}, async box => {
      const result = await box.exec(node(`const fs = require('node:fs'), assert = require('node:assert/strict');
        assert.equal(fs.readdirSync('/workspace/large').length, 2560);
        assert.throws(() => fs.readFileSync('/workspace/large/hard-link'));
        console.log('complete supported entries');`), { check: true });
      assert.match(result.stdout, /complete supported entries/);
      assert.ok(result.hostEntriesOmitted >= 2);
    });
  });

  await t.test('duplicate, nested and private runtime mounts reject caller marker spoofing', async () => {
    for (const mounts of [
      [mount, mount], [mount, { ...mount, guestPath: '/workspace/nested' }],
      [{ ...mount, guestPath: '/.wasmdbox', internal: true, internalRuntime: true }],
      [{ ...mount, guestPath: '/.wasmdbox/ca' }],
    ]) await assert.rejects(create({ mounts }), { code: 'CREATE_FAILED' });
    await assert.rejects(create({ mounts: [{ hostPath: join(root, 'missing-secret-path'), guestPath: '/workspace' }] }), error => {
      assert.equal(error.code, 'CREATE_FAILED');
      assert.equal(error.message.includes(root), false);
      return true;
    });
  });
});
