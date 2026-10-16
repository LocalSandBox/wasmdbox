import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from 'wasmdbox';

const root = await mkdtemp(join(tmpdir(), 'wasmdbox-private-ca-'));
const runtimeRoot = join(root, 'runtime');
await mkdir(runtimeRoot);
process.env.TMPDIR = process.env.TEMP = process.env.TMP = runtimeRoot;
const options = { network: { secrets: { TOKEN: { value: 'fixture-secret', hosts: ['fixture.test'] } } } };
let box;
try {
  await assert.rejects(Sandbox.create({ ...options, startupTimeoutMs: 0 }), { code: 'STARTUP_TIMEOUT' });
  assert.deepEqual(await readdir(runtimeRoot), []);
  await assert.rejects(Sandbox.create({ ...options, signal: AbortSignal.timeout(20) }), { code: 'STARTUP_ABORTED' });
  assert.deepEqual(await readdir(runtimeRoot), []);
  // Uncloneable options fail before the supervisor owns the directory.
  await assert.rejects(Sandbox.create({ ...options, invalid: () => {} }), { code: 'INVALID_OPTIONS' });
  assert.deepEqual(await readdir(runtimeRoot), []);
  box = await Sandbox.create(options);
  assert.equal((await readdir(runtimeRoot)).length, 1);
  assert.equal((await box.exec(['bash', '-c', 'printf ready'], { check: true })).stdout, 'ready');
  const command = await box.spawn(['bash', '-c', 'sleep 30']);
  command.stdout.resume(); command.stderr.resume();
  await command.kill();
  await assert.rejects(command.wait(), { code: 'KILLED' });
  // Command cancellation keeps the sandbox alive; its runtime trust stays valid.
  assert.equal((await readdir(runtimeRoot)).length, 1);
  const close = box.close();
  assert.equal(close, box.close());
  await close;
  assert.deepEqual(await readdir(runtimeRoot), []);
  box = await Sandbox.create({ network: { allow: [] } });
  assert.deepEqual(await readdir(runtimeRoot), [], 'no CA directory for allow-only networking');
  await box.close();
  console.log('private CA lifecycle passed');
} finally { await box?.close(); await rm(root, { recursive: true, force: true }); }
