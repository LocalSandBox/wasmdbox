import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Sandbox, SandboxError, CommandError } from 'wasmdbox';

const [action, cacheDir, ...extraPkgs] = process.argv.slice(2);
const options = { cacheDir, extraPkgs };
const expected = process.env.WASMDBOX_EXPECTED_ERROR;
if (expected) {
  await assert.rejects(run(), error => error instanceof SandboxError && error.code === expected);
} else {
  await run();
}
console.log(`PASS: ${action}`);
// Natural subprocess exit also verifies that no referenced worker survives.

async function run() {
  if (action === 'prepare') {
    assert.equal(await Sandbox.prepare(options), undefined);
    return;
  }
  if (action === 'abort' || action === 'timeout') {
    const controller = new AbortController();
    const pending = Sandbox.prepare({ ...options, startupTimeoutMs: action === 'timeout' ? 1_000 : 10_000, signal: controller.signal });
    void pending.catch(() => {});
    if (action === 'abort') {
      const limit = Date.now() + 5_000;
      while (!(await readReport()).includes('"tick"')) {
        assert.ok(Date.now() < limit, 'the package loader must reach its stalled state');
        await delay(20);
      }
      controller.abort();
    }
    await assert.rejects(pending, { name: 'SandboxError', code: action === 'abort' ? 'STARTUP_ABORTED' : 'STARTUP_TIMEOUT' });
    const stopped = await readReport();
    assert.match(stopped, /"tick"/);
    await delay(100);
    assert.equal(await readReport(), stopped, 'preparation settlement must stop the worker');
    return;
  }

  // Ablation: creation cannot depend on calling the public preparation method.
  Sandbox.prepare = () => { throw new Error('create() must be independent of prepare()'); };
  const sandbox = await Sandbox.create({
    ...options,
    files: { '/workspace/guest.py': await readFile(new URL('./extra-guest.py', import.meta.url)) },
  });
  try {
    assert.match((await sandbox.exec(['node', '--version'], { check: true, timeoutMs: 30_000 })).stdout, /^v\d+/);
    if (action === 'create-default') {
      await assert.rejects(sandbox.exec(['python', '--version']), { name: 'CommandError', code: 'COMMAND_NOT_FOUND' });
      assert.equal((await sandbox.exec(['bash', '-c', 'printf defaults'], { check: true })).stdout, 'defaults');
    } else {
      assert.equal((await sandbox.exec(['python', '/workspace/guest.py'], { check: true, timeoutMs: 30_000 })).stdout, 'python extra package works\n');
      await assert.rejects(sandbox.exec(['bash', '-c', 'true']), error => error instanceof CommandError && error.code === 'COMMAND_AMBIGUOUS');
    }
  } finally { await sandbox.close(); }
}

async function readReport() {
  try { return await readFile(process.env.WASMDBOX_PACKAGE_REPORT, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
