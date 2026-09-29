import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { materializeSdk, projectRoot } from './vendor-sdk.mjs';

const outputDirectory = join(projectRoot, '.artifacts/ablation');
await mkdir(outputDirectory, { recursive: true });
const adapterDirectory = join(outputDirectory, 'compiled-adapters');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    join(projectRoot, 'node_modules/typescript/bin/tsc'),
    'src/internal/node-host-filesystem.ts', 'src/internal/node-tcp-proxy.ts',
    '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--strict', '--skipLibCheck', '--types', 'node', '--outDir', adapterDirectory,
  ], { cwd: projectRoot, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('Adapter compilation failed')));
});
const variants = [
  { name: 'full', probes: ['mount', 'mount-failure', 'tcp', 'dns', 'listener', 'keepalive', 'fatal-worker'], expected: true },
  { name: 'stock-sdk', groups: [], adapters: false, nodeOnly: false, probes: ['mount'], expected: false, failure: /ENOENT/ },
  { name: 'no-mount-worker', omit: ['mounts:dist/node-worker.js:0', 'mounts:dist/node-worker.js:1'], probes: ['mount'], expected: false, failure: /ENOENT/ },
  { name: 'no-mount-worker-route', omit: ['mounts:dist/node-worker-adapter.js:0', 'mounts:dist/node-worker-adapter.js:1', 'mounts:dist/node-worker-adapter.js:2'], probes: ['mount'], expected: false, timeout: true },
  { name: 'no-client-mount-cleanup', omit: ['mounts:dist/node.js:2'], probes: ['mount', 'mount-failure'], expected: false, failure: /mounts: 2/ },
  { name: 'no-tcp-patch', groups: ['mounts', 'workerFailures'], probes: ['tcp'], expected: false, failure: /denied guest TCP reached the direct target/ },
  { name: 'no-dns-alias', omit: ['network:dist/node-network.js:3'], probes: ['dns'], expected: false, failure: /ENOTFOUND/ },
  { name: 'no-listener-block', omit: ['network:dist/node-network.js:5'], probes: ['listener'], expected: false, failure: /Missing expected exception/ },
  { name: 'no-keepalive', probes: ['no-keepalive'], expected: false, failure: /ENOSYS/ },
  { name: 'no-failure-forwarding', omit: ['workerFailures:dist/node-worker-adapter.js:1'], probes: ['fatal-worker'], expected: false, failure: /SDK failure was not forwarded/ },
];
const selected = process.argv.slice(2);
const results = [];
for (const variant of variants.filter(value => value.name === 'full' || !selected.length || selected.includes(value.name))) {
  const destination = join(outputDirectory, variant.name);
  const build = await materializeSdk({ ...variant, destination, adapterDirectory });
  for (const probe of variant.probes) {
    const result = await runProbe(destination, probe);
    const matchedExpected = result.success === variant.expected
      && (variant.expected || (variant.timeout ? result.timedOut : !result.timedOut && variant.failure.test(result.stderr)));
    results.push({ variant: variant.name, probe, expectedSuccess: variant.expected, matchedExpected, ...result, runtimeEdits: build.edits });
    console.log(`${matchedExpected ? 'PASS' : 'FAIL'} ${variant.name}/${probe}: ${result.success ? 'completed' : result.timedOut ? 'timed out' : 'rejected'}`);
    await writeFile(join(outputDirectory, 'results.json'), JSON.stringify({ node: process.version, sdk: '0.19.0', runtime: 'wasmer/edgejs-quickjs@=0.1.4', results }, null, 2) + '\n');
  }
  if (variant.name === 'full') assert.ok(results.every(result => result.success), 'positive controls must pass before interpreting any ablation failure');
}
assert.ok(results.length, 'no matching ablation variants');
assert.ok(results.every(result => result.matchedExpected), 'ablation result differed from its expected control; see .artifacts/ablation/results.json');

function runProbe(destination, probe) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(projectRoot, 'scripts/ablation-probe.mjs'), destination, probe], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ success: code === 0 && !timedOut, code, signal, timedOut, durationMs: Date.now() - started, stdout, stderr });
    });
  });
}
