import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from 'wasmdbox';

const cacheDir = fileURLToPath(new URL('../.wasmer/', import.meta.url));
const node = script => ['node', '-e', script];

test('host-backed workspace real WASM contract', { timeout: 240_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wasmdbox-workspace-'));
  const mount = { hostPath: root, guestPath: '/workspace' };
  t.after(() => rm(root, { recursive: true, force: true }));
  const create = options => Sandbox.create({ cacheDir, mounts: [mount], ...options });
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
