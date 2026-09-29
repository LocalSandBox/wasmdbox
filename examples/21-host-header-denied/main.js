import { Sandbox } from 'wasmdbox';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { generate } from 'selfsigned';

// MITM rejects a Host header that differs from the target domain. The guest uses native Node networking APIs.
const fixture = await startFixture();
let sandbox;

try {
  sandbox = await Sandbox.create({
    cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
    files: { '/workspace/guest.cjs': await readFile(new URL('./guest.cjs', import.meta.url)) },
    env: { API_URL: `https://api.demo.test:${fixture.port}/demo` },
    network: {
      allow: ['api.demo.test'],
      secrets: {
        API_KEY: { value: 'host-only-demo-token', hosts: ['api.demo.test'], ports: [fixture.port] },
      },
      // Only needed for this local HTTPS fixture; public requests need no DNS override or extra CA.
      dns: { 'api.demo.test': ['127.0.0.1'] },
      caCerts: [fixture.ca],
    },
  });
  const result = await sandbox.exec(['node', '/workspace/guest.cjs'], { timeoutMs: 30_000, check: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(fixture.connections, 0);
  assert.deepEqual(fixture.seen, []);
  console.log('PASS: 21 MITM rejects a Host header that differs from the target domain');
} finally {
  await cleanup(() => sandbox?.close(), () => fixture.close());
}

// ---- Setup helpers: this example owns its HTTPS fixture and cleanup ----

async function startFixture() {
  const certificate = await generate([{ name: 'commonName', value: 'api.demo.test' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [
      { type: 2, value: 'api.demo.test' }, { type: 2, value: 'docs.demo.test' },
    ] }],
  });
  const seen = [];
  let connections = 0;
  const server = createServer({ key: certificate.private, cert: certificate.cert }, (request, response) => {
    const record = { reached: true };
    seen.push(record);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(record));
  });
  server.on('connection', () => { connections += 1; });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port, ca: certificate.cert, seen,
    get connections() { return connections; },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function cleanup(...actions) {
  const errors = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Cleanup failed');
}
