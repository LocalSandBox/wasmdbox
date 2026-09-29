import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Sandbox } from 'wasmdbox';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const loader = new URL('./fixtures/package-loader.mjs', import.meta.url).href;
const runner = fileURLToPath(new URL('./fixtures/package-runner.mjs', import.meta.url));
const python = 'python/python@=3.13.20';
const runtime = 'wasmer/edgejs-quickjs@=0.1.4';

test('prepare and create independently acquire and reuse runtime packages', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-packages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDir = join(directory, 'cache with spaces');
  let sequence = 0;
  const run = (action, packages = [], flags = {}) => probe(action, cacheDir, packages, join(directory, `${++sequence}.jsonl`), flags);

  await t.test('cold preparation downloads dependencies without a sandbox or listener', async () => {
    const events = await run('prepare', [python], { WASMDBOX_FORBID_SANDBOX: '1' });
    assert.equal(events.some(event => event.type === 'sandbox'), false);
    assert.ok(events.some(event => event.type === 'fetch' && event.download));
    assert.deepEqual(events.find(event => event.type === 'load').sources, [runtime, python]);
    const files = await readdir(join(cacheDir, 'cache-v1/packages'));
    assert.ok(files.filter(file => file.endsWith('.bin')).length >= 4);
    for (const name of ['wasmer#edgejs-quickjs', 'wasmer#bash', 'wasmer#coreutils', 'python#python']) {
      assert.ok((await readFile(join(cacheDir, 'cache-v1/registry', name))).length);
    }
  });
  await t.test('a new process creates from prepared content without downloading package bodies', async () => {
    const events = await run('create-extra', [python], { WASMDBOX_BLOCK_DOWNLOADS: '1' });
    assert.equal(events.some(event => event.type === 'fetch' && event.download), false);
    assert.deepEqual(events.find(event => event.type === 'sandbox').ids, ['wasmer/edgejs-quickjs@0.1.4', 'python/python@3.13.20']);
  });
  await t.test('cached extras are not installed unless create requests them', async () => {
    await run('create-default', [], { WASMDBOX_BLOCK_DOWNLOADS: '1' });
  });
  await t.test('repeated prepare calls and different extra lists reuse the same cache', async () => {
    for (const packages of [[python], []]) {
      await run('prepare', packages, { WASMDBOX_BLOCK_DOWNLOADS: '1', WASMDBOX_FORBID_SANDBOX: '1' });
    }
  });
  await t.test('exact duplicates and aliases resolving to the same package are deduplicated', async () => {
    const events = await run('create-extra', [python, python, runtime, 'wasmer/edgejs-quickjs@>=0.1.4,<=0.1.4'], { WASMDBOX_BLOCK_DOWNLOADS: '1' });
    assert.equal(events.find(event => event.type === 'load').sources.length, 3);
    assert.deepEqual(events.find(event => event.type === 'sandbox').ids, ['wasmer/edgejs-quickjs@0.1.4', 'python/python@3.13.20']);
  });
  await t.test('an unknown package fails preparation and creation without deleting cached packages', async () => {
    const existing = (await readdir(join(cacheDir, 'cache-v1/packages'))).sort();
    const missing = ['wasmdbox-tests/package-does-not-exist@=0.0.0'];
    await run('prepare', missing, { WASMDBOX_EXPECTED_ERROR: 'PREPARE_FAILED' });
    await run('create-extra', missing, { WASMDBOX_EXPECTED_ERROR: 'CREATE_FAILED' });
    assert.deepEqual((await readdir(join(cacheDir, 'cache-v1/packages'))).sort(), existing);
    await run('create-default', [], { WASMDBOX_BLOCK_DOWNLOADS: '1' });
  });
  await t.test('create downloads missing packages without a preceding prepare', async () => {
    const events = await probe('create-extra', join(directory, 'create-only'), [python], join(directory, 'create-only.jsonl'));
    assert.ok(events.some(event => event.type === 'fetch' && event.download));
  });
  await t.test('the explicit CLI honors its cache directory and extra package arguments', async () => {
    const report = join(directory, 'cli.jsonl');
    const { stdout } = await execute(process.execPath, ['--import', loader, 'scripts/prepare-runtime.mjs', '--cache-dir', cacheDir, python], {
      cwd: root, timeout: 60_000,
      env: { ...process.env, WASMDBOX_PACKAGE_REPORT: report, WASMDBOX_BLOCK_DOWNLOADS: '1', WASMDBOX_FORBID_SANDBOX: '1' },
    });
    assert.ok(stdout.includes(cacheDir));
    const events = await readEvents(report);
    assert.deepEqual(events.find(event => event.type === 'load').sources, [runtime, python]);
    assert.equal(events.some(event => event.type === 'sandbox' || event.download), false);
  });
});

test('preparation failure, timeout, cancellation and cleanup use SandboxError', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-prepare-fault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheDir = resolve(root, '.wasmer');
  for (const action of ['timeout', 'abort']) {
    await t.test(action, () => probe(action, cacheDir, [], join(directory, `${action}.jsonl`), { WASMDBOX_PACKAGE_FAULT: 'stalled-load' }));
  }
  await t.test('download failure', async () => {
    const events = await probe('prepare', join(directory, 'empty-cache'), [], join(directory, 'download.jsonl'), {
      WASMDBOX_PACKAGE_FAULT: 'download-failure', WASMDBOX_EXPECTED_ERROR: 'PREPARE_FAILED',
    });
    assert.ok(events.some(event => event.download));
  });
  await t.test('client cleanup failure', () => probe('prepare', cacheDir, [], join(directory, 'close.jsonl'), {
    WASMDBOX_PACKAGE_FAULT: 'close-failure', WASMDBOX_EXPECTED_ERROR: 'CLOSE_FAILED',
  }));
});

test('prepare and create validate extraPkgs and preparation startup options', async () => {
  for (const extraPkgs of [null, 'python/python', [null], [7], [''], [' '], ['a\0b'], new Array(1)]) {
    for (const method of ['prepare', 'create']) {
      await assert.rejects(Sandbox[method]({ extraPkgs }), { name: 'SandboxError', code: 'INVALID_OPTIONS' });
    }
  }
  await assert.rejects(Sandbox.prepare(null), { code: 'INVALID_OPTIONS' });
  await assert.rejects(Sandbox.prepare({ startupTimeoutMs: -1 }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(Sandbox.prepare({ signal: {} }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(Sandbox.prepare({ signal: AbortSignal.abort() }), { code: 'STARTUP_ABORTED' });
  await assert.rejects(Sandbox.prepare({ startupTimeoutMs: 0 }), { code: 'STARTUP_TIMEOUT' });
});

async function probe(action, cacheDir, packages, report, flags = {}) {
  const { stdout } = await execute(process.execPath, ['--import', loader, runner, action, cacheDir, ...packages], {
    cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, WASMDBOX_PACKAGE_REPORT: report, ...flags },
  });
  assert.match(stdout, new RegExp(`PASS: ${action}`));
  return readEvents(report);
}

async function readEvents(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
