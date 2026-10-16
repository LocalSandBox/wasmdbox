import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('cold cancellation stops host writes and leaves the sandbox reusable across 20 cycles', { timeout: 120_000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/cancel-cycle-repro.mjs', import.meta.url)), '20',
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 110_000 });
  const rounds = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rounds.length, 20);
  assert.ok(rounds.every(result => result.wrote));
});
