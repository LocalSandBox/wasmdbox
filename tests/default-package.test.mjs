import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from 'wasmdbox';

const cacheDir = fileURLToPath(new URL('../.wasmer/', import.meta.url));

test('explicit default package resolves Bash with Python installed and preserves ordinary ambiguity', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wasmdbox-default-package-'));
  let box;
  try {
    box = await Sandbox.create({ cacheDir, extraPkgs: ['python/python@=3.13.20'], mounts: [{ hostPath: root, guestPath: '/workspace' }] });
    await assert.rejects(box.exec(['bash', '-c', 'true']), { code: 'COMMAND_AMBIGUOUS' });
    const shell = await box.exec(['bash', '-c', 'printf persisted > selected.txt; python --version'], { package: 'default', check: true });
    assert.match(shell.stdout, /^Python 3\./);
    assert.equal(await readFile(join(root, 'selected.txt'), 'utf8'), 'persisted');
    await box.exec(['bash', '-c', `node -e 'const fs = require("node:fs"); fs.writeFileSync("child.bin", Buffer.from([0,128,255])); fs.renameSync("child.bin", "renamed.bin");'`], { package: 'default', check: true });
    assert.deepEqual(await readFile(join(root, 'renamed.bin')), Buffer.from([0,128,255]));
    assert.match((await box.exec(['node', '--version'], { package: 'default', check: true })).stdout, /^v\d+/);
    await assert.rejects(box.exec(['python', '--version'], { package: 'default' }), { code: 'COMMAND_NOT_FOUND' });
    for (const value of ['python/python@=3.13.20', '', null, 1, {}]) {
      await assert.rejects(box.exec(['bash', '-c', 'true'], { package: value }), { code: 'INVALID_OPTIONS' });
      await assert.rejects(box.spawn(['bash', '-c', 'true'], { package: value }), { code: 'INVALID_OPTIONS' });
    }
    const proc = await box.spawn(['bash', '-c', 'printf followup'], { package: 'default', check: true });
    proc.stdout.resume(); proc.stderr.resume();
    assert.equal((await proc.wait()).stdout, 'followup');
    await assert.rejects(box.exec(['bash', '-c', 'true']), { code: 'COMMAND_AMBIGUOUS' });
  } finally { await box?.close(); await rm(root, { recursive: true, force: true }); }
});
