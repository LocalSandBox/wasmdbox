import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Sandbox } from 'wasmdbox';

const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-output-close-'));
const report = join(directory, 'wait.txt');
const finished = process.argv[2] === 'finished';
const sandbox = await Sandbox.create({
  cacheDir: '.wasmer', env: { WASMDBOX_TEST_FAULT: 'stalled-output', WASMDBOX_TEST_WAIT_REPORT: report },
});
try {
  const command = await sandbox.spawn(['bash', '-c', finished ? 'printf done' : 'sleep 30']);
  if (finished) {
    const deadline = Date.now() + 15_000;
    while (true) {
      try { if (await readFile(report, 'utf8') === 'finished') break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(Date.now() < deadline, 'underlying process.wait() must finish before close');
      await delay(20);
    }
  }
  await sandbox.close();
  await assert.rejects(command.wait(), { code: 'SANDBOX_CLOSED' });
  console.log('stalled output closed');
} finally {
  try { await sandbox.close(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
