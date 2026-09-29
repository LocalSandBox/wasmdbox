import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sandbox, SandboxError, CommandError } from 'wasmdbox';

const mode = process.argv[2];
const cacheDir = resolve('.wasmer');
const root = await mkdtemp(join(tmpdir(), 'wasmdbox-fault-'));
const other = await Sandbox.create({ cacheDir });
let box;
try {
  let observed;
  try {
    box = await Sandbox.create({
      cacheDir, env: { WASMDBOX_TEST_FAULT: mode },
      mounts: [{ hostPath: root, guestPath: '/mounted' }],
      ...(mode === 'proxy-failure' ? { network: {} } : {}),
    });
    if (mode === 'close-failure') await box.close();
    else await box.exec(['bash', '-c', 'sleep 5'], { timeoutMs: mode === 'stalled-command' ? 20 : 10_000 });
  } catch (error) { observed = error; }
  assert.ok(observed instanceof SandboxError, `expected SandboxError for ${mode}: ${observed}`);
  assert.equal(observed instanceof CommandError, false);
  const expected = {
    'runtime-error': 'WORKER_FAILED', 'stalled-command': 'SANDBOX_UNRESPONSIVE',
    'startup-failure': 'CREATE_FAILED', 'close-failure': 'CLOSE_FAILED',
    'invalid-protocol': 'PROTOCOL_ERROR', 'unexpected-exit': 'WORKER_FAILED',
    'proxy-failure': 'PROXY_FAILED',
  }[mode];
  assert.equal(observed.code, expected);
  assert.equal((await other.exec(['bash', '-c', 'printf unaffected'], { check: true })).stdout, 'unaffected');
  console.log(mode + ': ' + observed.code);
} finally {
  await Promise.allSettled([box?.close(), other.close()]);
  await rm(root, { recursive: true, force: true });
}
