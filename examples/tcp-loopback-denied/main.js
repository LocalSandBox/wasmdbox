import { Sandbox } from 'wasmdbox';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

// Raw TCP connections to IPv4 loopback are disabled. Guest code is in guest.cjs.
let sandbox;
let listener;

try {
  listener = await startListener('127.0.0.1');
  sandbox = await Sandbox.create({
    cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
    files: {
      '/workspace/app/case.cjs': await readFile(new URL('./guest.cjs', import.meta.url)),
    },
  });
  const output = await sandbox.exec(['node', '/workspace/app/case.cjs', String(listener.port)], {
    timeoutMs: 30_000, check: true,
  });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  assert.equal(listener.connections, 0);
} finally {
  await cleanup(
    () => sandbox?.close(),
    () => listener?.close(),
  );
}
console.log('PASS: Raw TCP connections to IPv4 loopback are disabled');

// ---- Setup helpers: resource cleanup and test data ----

async function cleanup(...actions) {
  const errors = [];
  for (const action of actions) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Cleanup failed');
}

async function startListener(host) {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return {
    port: server.address().port,
    get connections() { return connections; },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
