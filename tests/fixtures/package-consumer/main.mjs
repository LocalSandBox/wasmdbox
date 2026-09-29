import { Sandbox, CommandError, SandboxError } from 'wasmdbox';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { generate } from 'selfsigned';

const resolved = await realpath(fileURLToPath(import.meta.resolve('wasmdbox')));
const installedEntry = await realpath('node_modules/wasmdbox/dist/index.js');
assert.equal(resolved, installedEntry, 'consumer must load the installed artifact');
assert.equal(new CommandError('TIMEOUT', 'test') instanceof SandboxError, false);
const extraPkgs = ['python/python@=3.13.20'];
await Sandbox.prepare({ cacheDir: process.env.WASMDBOX_VERIFY_CACHE, extraPkgs });
await mkdir('mounted');
const fixture = await startFixture();
let sandbox;
try {
  sandbox = await Sandbox.create({
    cacheDir: process.env.WASMDBOX_VERIFY_CACHE,
    files: { '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)) },
    mounts: [{ hostPath: './mounted', guestPath: '/mounted' }],
    env: {
      API_URL: `https://package.demo.test:${fixture.port}/`,
      RESULT_PATH: '/mounted/result.txt',
    },
    network: {
      allow: ['package.demo.test'],
      dns: { 'package.demo.test': ['127.0.0.1'] },
      caCerts: [fixture.ca],
      secrets: { API_KEY: { value: 'package-fixture-value', hosts: ['package.demo.test'], ports: [fixture.port] } },
    },
  });
  assert.equal('fs' in sandbox, false);
  const result = await sandbox.exec(['node', '/workspace/guest.cjs'], { check: true, timeoutMs: 30_000 });
  assert.match(result.stdout, /installed consumer guest passed/);
  assert.equal((await sandbox.exec(['bash', '-c', 'printf shell-ready'], { check: true })).stdout, 'shell-ready');
  assert.deepEqual(fixture.seen, [{ authorized: true }]);
} finally {
  try { await sandbox?.close(); }
  finally { await fixture.close(); }
}
assert.equal(await readFile('mounted/result.txt', 'utf8'), 'written by installed package\n');
console.log('PASS: installed package host mount writes persist');
console.log('PASS: installed package JS consumer, Node/Bash, files and native HTTPS secrets');

const extra = await Sandbox.create({ cacheDir: process.env.WASMDBOX_VERIFY_CACHE, extraPkgs });
try {
  assert.match((await extra.exec(['python', '--version'], { check: true })).stdout, /^Python 3\./);
  assert.match((await extra.exec(['node', '--version'], { check: true })).stdout, /^v\d+/);
} finally { await extra.close(); }
console.log('PASS: installed package prepare() and extraPkgs');

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
