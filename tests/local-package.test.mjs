import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const runner = fileURLToPath(new URL('./fixtures/local-package-runner.mjs', import.meta.url));
const loader = new URL('./fixtures/package-loader.mjs', import.meta.url).href;
const runtime = 'wasmer/edgejs-quickjs@=0.1.4';

test('local WEBC bytes cross the worker boundary and export runnable commands', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-local-webc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDir = join(directory, 'cache');
  const fixture = await readFile(new URL('../examples/local-package/hello.webc', import.meta.url));
  const expectedBytes = {
    length: fixture.length, offset: 0, bufferLength: fixture.length,
    sha256: createHash('sha256').update(fixture).digest('hex'),
  };
  let sequence = 0;
  async function run(action, variant, blockDownloads = true) {
    const report = join(directory, `${++sequence}.jsonl`);
    const { stdout } = await execute(process.execPath, ['--import', loader, runner, action, cacheDir, variant], {
      cwd: root, timeout: 90_000, maxBuffer: 1024 * 1024,
      env: {
        ...process.env, WASMDBOX_PACKAGE_REPORT: report,
        ...(blockDownloads ? { WASMDBOX_BLOCK_DOWNLOADS: '1' } : {}),
        ...(action === 'prepare' ? { WASMDBOX_FORBID_SANDBOX: '1' } : {}),
      },
    });
    assert.ok(stdout.includes(`PASS: ${action} ${variant}`));
    const events = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (blockDownloads) assert.equal(events.some(event => event.type === 'fetch' && event.download), false);
    if (action === 'prepare') assert.equal(events.some(event => event.type === 'sandbox'), false);
    if (variant !== 'corrupt' && action !== 'create-default') {
      const load = events.find(event => event.type === 'load');
      assert.deepEqual(load.sources, [runtime]);
      assert.ok(load.bytes.length > 0);
      for (const bytes of load.bytes) assert.deepEqual(bytes, expectedBytes);
    }
    return events;
  }

  await t.test('Buffer loads directly without prepare or a published package', () => run('create', 'buffer', false));
  await t.test('prepare accepts Uint8Array without creating a sandbox or listener', () => run('prepare', 'uint8'));
  for (const variant of ['uint8', 'subarray', 'buffer-subarray', 'shared']) {
    await t.test(`${variant} snapshots the visible bytes before caller mutation`, () => run('create', variant));
  }
  await t.test('mixed references and duplicate byte packages retain one package per ID', async () => {
    const events = await run('create', 'duplicates');
    const loaded = events.find(event => event.type === 'loaded').ids;
    const installed = events.find(event => event.type === 'sandbox').ids;
    assert.ok(loaded.length > installed.length);
    assert.equal(installed.length, 2);
    assert.deepEqual(installed, [...new Set(loaded)]);
  });
  await t.test('cached local packages are absent unless create requests them', () => run('create-default', 'buffer'));
  for (const action of ['prepare', 'create']) {
    await t.test(`${action} rejects corrupt package bytes and cleans up`, () => run(action, 'corrupt'));
  }
});
