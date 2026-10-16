import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Sandbox } from 'wasmdbox';

const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-spawn-close-'));
const report = join(directory, 'operations.txt');
const box = await Sandbox.create({ env: {
  WASMDBOX_TEST_FAULT: 'spawn-close-race', WASMDBOX_TEST_WAIT_REPORT: report,
} });
try {
  const pending = box.exec(['bash', '-c', 'sleep 30']);
  const rejected = assert.rejects(pending, { code: 'SANDBOX_CLOSED' });
  const deadline = Date.now() + 30_000;
  while (true) {
    try { if ((await readFile(report, 'utf8')).includes('spawn-pending')) break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'spawn must reach the controlled ownership handoff');
    await delay(20);
  }
  await box.close();
  await rejected;
  assert.equal(await readFile(report, 'utf8'), 'spawn-pending\n', 'no cooperative operation may race owner teardown');
  console.log('pending spawn close ownership passed');
} finally {
  try { await box.close(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
