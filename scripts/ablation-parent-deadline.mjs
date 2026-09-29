import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.artifacts/ablation/public-parent-deadline');
await mkdir(output, { recursive: true });
const full = join(output, 'full');
const removed = join(output, 'without-parent-deadline');
await rm(full, { recursive: true, force: true });
await cp(join(root, 'dist'), full, { recursive: true });
await rm(removed, { recursive: true, force: true });
await cp(full, removed, { recursive: true });

const path = join(removed, 'sandbox.js');
const source = await readFile(path, 'utf8');
const anchor = `        if (options.timeoutMs !== undefined)\n            running.timer = setTimeout(() => this.#cancel(id, 'TIMEOUT'), options.timeoutMs);\n`;
assert.equal(source.split(anchor).length, 2, 'parent deadline anchor must occur exactly once');
const mutated = source.replace(anchor, '');
await writeFile(path, mutated);
const hash = text => createHash('sha256').update(text).digest('hex');

const results = [];
for (const [name, distribution] of [['full', full], ['without-parent-deadline', removed]]) {
  const result = await run(distribution);
  const observation = result.code === 0 && !result.timedOut
    ? JSON.parse(result.stdout.trim().split('\n').at(-1)) : undefined;
  const matchedExpected = name === 'full'
    ? observation?.kind === 'rejected' && ['TIMEOUT', 'SANDBOX_UNRESPONSIVE'].includes(observation.code)
    : observation?.kind === 'completed' && observation.exitCode === 0;
  results.push({ name, matchedExpected, ...result, observation });
  await writeFile(join(output, 'results.json'), JSON.stringify({
    node: process.version,
    command: ['bash', '-c', 'sleep 1'], timeoutMs: 20,
    mutation: { file: 'sandbox.js', originalSha256: hash(source), removedSha256: hash(mutated), removed: anchor },
    results,
  }, null, 2) + '\n');
  console.log(`${matchedExpected ? 'PASS' : 'FAIL'} ${name}: ${observation ? JSON.stringify(observation) : 'probe did not complete'}`);
  assert.ok(matchedExpected, `Unexpected ${name} result; see ${join(output, 'results.json')}`);
}

function run(distribution) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/ablation-public-probe.mjs'), distribution], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}
