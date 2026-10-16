import { Sandbox, CommandError, SandboxError, NETWORK_PORT_POLICY_VERSION } from 'wasmdbox';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { generate } from 'selfsigned';

assert.equal(NETWORK_PORT_POLICY_VERSION, 1);
const resolved = await realpath(fileURLToPath(import.meta.resolve('wasmdbox')));
const installedEntry = await realpath('node_modules/wasmdbox/dist/index.js');
assert.equal(resolved, installedEntry, 'consumer must load the installed artifact');
assert.equal(new CommandError('TIMEOUT', 'test') instanceof SandboxError, false);
const extraPkgs = [
  await readFile(new URL('../examples/local-package/hello.webc', import.meta.resolve('wasmdbox'))),
];
for (const packages of [['python/python@=3.13.20'], [...extraPkgs, 'wasmer/bash']]) {
  await assert.rejects(Sandbox.create({ extraPkgs: packages }), { name: 'SandboxError', code: 'INVALID_OPTIONS' });
}
console.log('PASS: installed package rejects string and mixed extraPkgs');
await assert.rejects(Sandbox.create({ cacheDir: './legacy-cache' }), { code: 'INVALID_OPTIONS', message: /cacheDir has been removed/ });
await mkdir('mounted');
const fixture = await startFixture();
let sandbox;
try {
  sandbox = await Sandbox.create({
    files: { '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)) },
    mounts: [{ hostPath: './mounted', guestPath: '/workspace' }],
    env: {
      API_URL: `https://package.demo.test:${fixture.port}/`,
      RESULT_PATH: '/workspace/result.txt',
    },
    network: {
      allow: ['package.demo.test'], ports: [fixture.port],
      dns: { 'package.demo.test': ['127.0.0.1'] },
      caCerts: [fixture.ca],
      secrets: { API_KEY: { value: 'package-fixture-value', hosts: ['package.demo.test'], ports: [fixture.port] } },
    },
  });
  assert.equal('fs' in sandbox, false);
  assert.equal(await readFile('mounted/guest.cjs', 'utf8'), await readFile(new URL('./guest.cjs', import.meta.url), 'utf8'), 'files imports persist to workspace host storage');
  const result = await sandbox.exec(['node', '/workspace/guest.cjs'], { check: true, timeoutMs: 30_000 });
  assert.match(result.stdout, /installed consumer guest passed/);
  assert.equal((await sandbox.exec(['bash', '-c', 'printf shell-ready'], { check: true })).stdout, 'shell-ready');
  assert.match((await sandbox.exec(['python', '--version'], { check: true })).stdout, /^Python 3\./);
  assert.deepEqual(fixture.seen, [{ authorized: true }]);
} finally {
  try { await sandbox?.close(); }
  finally { await fixture.close(); }
}
assert.equal(await readFile('mounted/result.txt', 'utf8'), 'written by installed package\n');
console.log('PASS: installed package host mount writes persist');
console.log('PASS: installed package JS consumer, Node/Bash, files and native HTTPS secrets');

const extra = await Sandbox.create({ extraPkgs });
try {
  assert.equal((await extra.exec(['bash', '-c', 'true'], { check: true })).exitCode, 0);
  assert.match((await extra.exec(['bash', '-c', 'python --version'], { package: 'default', check: true })).stdout, /^Python 3\./);
  assert.match((await extra.exec(['python', '--version'], { check: true })).stdout, /^Python 3\./);
  assert.match((await extra.exec(['node', '--version'], { check: true })).stdout, /^v\d+/);
  assert.equal((await extra.exec(['local-hello'], { check: true, timeoutMs: 30_000 })).stdout, 'hello from local webc\n');
} finally { await extra.close(); }
console.log('PASS: installed package bundled Python and local WEBC bytes without downloads');

async function startFixture() {
  const certificate = await generate([{ name: 'commonName', value: 'package.demo.test' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'package.demo.test' }] }],
  });
  const seen = [];
  const server = createServer({ key: certificate.private, cert: certificate.cert }, (request, response) => {
    const record = { authorized: request.headers.authorization === 'Bearer package-fixture-value' };
    seen.push(record);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(record));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port, ca: certificate.cert, seen,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
