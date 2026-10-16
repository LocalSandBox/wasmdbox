import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
test('close owns teardown when an in-flight spawn resumes', { timeout: 60_000 }, async () => {
  const { stdout } = await execute(process.execPath, [
    '--import', new URL('./fixtures/fault-loader.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/spawn-close-race.mjs', import.meta.url)),
  ], { cwd: root, timeout: 50_000 });
  assert.match(stdout, /pending spawn close ownership passed/);
});
for (const action of ['close', 'kill']) for (const mode of ['running', 'finished']) {
  test(`${action} releases a ${mode} process even when SDK output never reaches EOF`, { timeout: 60_000 }, async () => {
    const { stdout } = await execute(process.execPath, [
      '--import', new URL('./fixtures/fault-loader.mjs', import.meta.url).href,
      fileURLToPath(new URL('./fixtures/close-stalled-output.mjs', import.meta.url)), mode, action,
    ], { cwd: root, timeout: 50_000 });
    assert.match(stdout, /stalled output closed/);
  });
}

test('ESM eval callers and process-only flags support worker startup', { timeout: 60_000 }, async () => {
  for (const flag of [['--input-type=module'], ['--input-type', 'module']]) {
    const { stdout } = await execute(process.execPath, ['--stack-trace-limit=10', ...flag, '-e', `
      import { Sandbox } from 'wasmdbox';
      const box = await Sandbox.create();
      try { console.log((await box.exec(['bash', '-c', 'printf ready'], { check: true })).stdout); }
      finally { await box.close(); }
    `], { cwd: root, timeout: 50_000 });
    assert.equal(stdout.trim(), 'ready');
  }
});
for (const mode of ['runtime-error', 'stalled-command', 'startup-failure', 'close-failure', 'active-close-failure', 'invalid-protocol', 'unexpected-exit', 'proxy-failure']) {
  test(`infrastructure fault stays distinct and isolated: ${mode}`, { timeout: 60_000 }, async () => {
    const { stdout } = await execute(process.execPath, [
      '--import', new URL('./fixtures/fault-loader.mjs', import.meta.url).href,
      fileURLToPath(new URL('./fixtures/fault-runner.mjs', import.meta.url)), mode,
    ], { cwd: root, timeout: 50_000 });
    assert.match(stdout, new RegExp(mode));
  });
}

test('private CA directories are parent-owned through startup failure, cancellation and close', { timeout: 60_000 }, async () => {
  const { stdout } = await execute(process.execPath, [
    fileURLToPath(new URL('./fixtures/private-ca-lifecycle.mjs', import.meta.url)),
  ], { cwd: root, timeout: 50_000 });
  assert.match(stdout, /private CA lifecycle passed/);
});
