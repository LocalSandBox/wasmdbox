import { Sandbox, CommandError, SandboxError } from 'wasmdbox';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sandbox = await Sandbox.create({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
  files: { '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)) },
});

try {
  // A nonzero guest exit returns a result by default.
  const result = await sandbox.exec(['node', '/workspace/guest.cjs']);
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /guest rejected the input/);

  // check:true lets the caller handle the same result with try/catch.
  await assert.rejects(
    sandbox.exec(['node', '/workspace/guest.cjs'], { check: true }),
    error => error instanceof CommandError && error.result.exitCode === 7,
  );

  // The sandbox remains usable after a command fails.
  const next = await sandbox.exec(['bash', '-c', 'printf "still usable"'], { check: true });
  assert.equal(next.stdout, 'still usable');
} finally {
  await sandbox.close();
}

await assert.rejects(sandbox.exec(['node', '/workspace/guest.cjs']), SandboxError);
console.log('PASS: 27 Guest command failures and sandbox lifecycle errors use separate classes');
