import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
test('ESM eval callers and process-only flags support worker startup', { timeout: 60_000 }, async () => {
  for (const flag of [['--input-type=module'], ['--input-type', 'module']]) {
    const { stdout } = await execute(process.execPath, ['--stack-trace-limit=10', ...flag, '-e', `
      import { Sandbox } from 'wasmdbox';
      const box = await Sandbox.create({ cacheDir: '.wasmer' });
      try { console.log((await box.exec(['bash', '-c', 'printf ready'], { check: true })).stdout); }
      finally { await box.close(); }
    `], { cwd: root, timeout: 50_000 });
    assert.equal(stdout.trim(), 'ready');
  }
});
for (const mode of ['runtime-error', 'stalled-command', 'startup-failure', 'close-failure', 'invalid-protocol', 'unexpected-exit', 'proxy-failure']) {
  test(`infrastructure fault stays distinct and isolated: ${mode}`, { timeout: 60_000 }, async () => {
    const { stdout } = await execute(process.execPath, [
      '--import', fileURLToPath(new URL('./fixtures/fault-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/fault-runner.mjs', import.meta.url)), mode,
    ], { cwd: root, timeout: 50_000 });
    assert.match(stdout, new RegExp(mode));
  });
}
