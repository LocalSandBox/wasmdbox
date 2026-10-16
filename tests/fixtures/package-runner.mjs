import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const { Sandbox, SandboxError } = await import(process.env.WASMDBOX_TEST_ENTRY ?? 'wasmdbox');
const [action, ...extraPkgs] = process.argv.slice(2);
const expected = process.env.WASMDBOX_EXPECTED_ERROR;
if (expected) {
  await assert.rejects(run(), error => {
    assert.ok(error instanceof SandboxError);
    assert.equal(error.code, expected);
    if (process.env.WASMDBOX_ERROR_MATCH) assert.match(error.message, new RegExp(process.env.WASMDBOX_ERROR_MATCH));
    return true;
  });
} else await run();
console.log(`PASS: ${action}`);
// Natural exit verifies that failed/cancelled creation leaves no live worker.
async function run() {
  if (action === 'abort' || action === 'timeout') {
    const controller = new AbortController();
    const pending = Sandbox.create({ startupTimeoutMs: action === 'timeout' ? 3_000 : 30_000, signal: controller.signal });
    void pending.catch(() => {});
    if (action === 'abort') {
      const limit = Date.now() + 20_000;
      while (!(await readReport()).includes('"tick"')) {
        assert.ok(Date.now() < limit, 'the loader must reach its stalled state');
        await delay(20);
      }
      controller.abort();
    }
    await assert.rejects(pending, { code: action === 'timeout' ? 'STARTUP_TIMEOUT' : 'STARTUP_ABORTED' });
    const stopped = await readReport();
    await delay(100);
    assert.equal(await readReport(), stopped, 'creation settlement must stop the worker');
    return;
  }
  const packages = ['create-bytes', 'conflict'].includes(action)
    ? await Promise.all(extraPkgs.map(path => readFile(path)))
    : action === 'invalid-mixed' ? [await readFile(extraPkgs[0]), ...extraPkgs.slice(1)] : extraPkgs;
  const sandbox = await Sandbox.create({ extraPkgs: packages, network: false });
  try {
    if (action === 'conflict') {
      await assert.rejects(sandbox.exec(['bash', '-c', 'true']), { code: 'COMMAND_AMBIGUOUS' });
      assert.equal((await sandbox.exec(['bash', '-c', 'printf defaults'], { package: 'default', check: true })).stdout, 'defaults');
      assert.match((await sandbox.exec(['python', '--version'], { package: 'default', check: true })).stdout, /^Python 3\./);
      return;
    }
    assert.match((await sandbox.exec(['node', '--version'], { check: true })).stdout, /^v\d+/);
    assert.match((await sandbox.exec(['python', '--version'], { check: true })).stdout, /^Python 3\./);
    assert.equal((await sandbox.exec(['bash', '-c', 'printf defaults'], { check: true })).stdout, 'defaults');
    assert.equal((await sandbox.exec(['echo', 'coreutils'], { check: true })).stdout, 'coreutils\n');
    assert.equal((await sandbox.exec(['[', '1', '=', '1', ']'], { check: true })).exitCode, 0);
    assert.match((await sandbox.exec(['pnpm', '--version'], { check: true })).stdout, /^10\.34\.5/);
    assert.match((await sandbox.exec(['pip', '--version'], { check: true })).stdout, /^pip /);
    assert.equal((await sandbox.exec(['python', '-c', 'import ssl,sqlite3,zoneinfo; assert ssl.create_default_context().get_ca_certs(); assert sqlite3.connect(":memory:").execute("select 3").fetchone()[0] == 3; print(zoneinfo.ZoneInfo("Asia/Singapore"))'], { check: true })).stdout, 'Asia/Singapore\n');
    assert.match((await sandbox.exec(['bash', '-c', 'node --version && python --version'], { check: true })).stdout, /v\d+.*\nPython 3\./);
    assert.match((await sandbox.exec(['node', '-e', "const {execFileSync}=require('child_process'); process.stdout.write(execFileSync('python',['--version'])); process.stdout.write(execFileSync('bash',['-c','echo node-child']));"], { check: true })).stdout, /Python 3\..*\nnode-child\n/);
    assert.match((await sandbox.exec(['python', '-c', "import subprocess; print(subprocess.check_output(['node', '--version']).decode(), end=''); print(subprocess.check_output(['echo', 'python-child']).decode(), end='')"], { check: true })).stdout, /v\d+.*\npython-child\n/);
    assert.match((await sandbox.exec(['python', '--version'], { package: 'default', check: true })).stdout, /^Python 3\./);
  } finally { await sandbox.close(); }
}
async function readReport() {
  try { return await readFile(process.env.WASMDBOX_PACKAGE_REPORT, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
