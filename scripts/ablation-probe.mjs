import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from 'selfsigned';
import { projectRoot } from './vendor-sdk.mjs';

const [sdkDirectory, probe] = process.argv.slice(2);
const sdkUrl = name => pathToFileURL(join(sdkDirectory, name)).href;
const { Wasmer } = await import(sdkUrl('dist/node.js'));

if (probe === 'mount' || probe === 'mount-failure') await mountProbe();
else if (probe === 'tcp') await tcpProbe();
else if (probe === 'dns') await dnsProbe();
else if (probe === 'listener') await listenerProbe();
else if (probe === 'keepalive' || probe === 'no-keepalive') await keepaliveProbe();
else if (probe === 'fatal-worker') await fatalWorkerProbe();
else throw new Error(`Unknown ablation probe: ${probe}`);
console.log(JSON.stringify({ probe, passed: true }));

function client(options = {}) {
  return new Wasmer({ parallelism: 2, outputBytes: 16 * 1024, cache: { directory: join(projectRoot, '.wasmer') }, ...options });
}

async function runtime(wasmer) {
  return wasmer.packages.load('wasmer/edgejs-quickjs@=0.1.4', { signal: AbortSignal.timeout(45_000) });
}

async function mountProbe() {
  const directory = await mkdtemp(join(tmpdir(), 'wasmdbox-ablation-mount-'));
  const wasmer = client();
  let sandbox;
  try {
    const pkg = await runtime(wasmer);
    await writeFile(join(directory, 'hello.txt'), 'before');
    await mkdir(join(directory, 'forbidden'));
    await symlink('../hello.txt', join(directory, 'forbidden/link'));
    await writeFile(join(directory, 'forbidden/hard-source'), 'linked');
    await link(join(directory, 'forbidden/hard-source'), join(directory, 'forbidden/hard-link'));
    const options = {
      packages: [pkg], network: { mode: 'disabled' },
      mounts: [
        { hostPath: directory, guestPath: '/mounted', readOnly: false },
        { hostPath: directory, guestPath: '/readonly', readOnly: true },
      ],
      files: { '/workspace/probe.cjs': `const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync('/mounted/hello.txt', 'utf8'), 'after');
assert.equal(fs.statSync('/mounted/hello.txt').isFile(), true);
assert.ok(fs.readdirSync('/mounted').includes('hello.txt'));
assert.equal(fs.readFileSync('/readonly/hello.txt', 'utf8'), 'after');
assert.throws(() => fs.writeFileSync('/readonly/hello.txt', 'blocked'));
assert.throws(() => fs.readFileSync('/mounted/forbidden/link'));
assert.throws(() => fs.readFileSync('/mounted/forbidden/hard-link'));
fs.mkdirSync('/mounted/nested');
fs.writeFileSync('/mounted/nested/large', Buffer.alloc(768 * 1024, 201));
assert.equal(fs.readFileSync('/mounted/nested/large').length, 768 * 1024);
fs.renameSync('/mounted/nested/large', '/mounted/nested/renamed');
fs.unlinkSync('/mounted/nested/renamed');
fs.rmdirSync('/mounted/nested');
fs.writeFileSync('/mounted/result.bin', Buffer.from([0, 128, 255]));
fs.openSync('/mounted/hello.txt', 'r');
console.log('mount-ok');` },
    };
    if (probe === 'mount-failure') {
      const { SandboxBuilderCore } = await import(sdkUrl('pkg/wasmer_sdk_js.js'));
      const original = SandboxBuilderCore.prototype.start;
      SandboxBuilderCore.prototype.start = function () { this.free(); throw new Error('ablation startup failure'); };
      try { await assert.rejects(wasmer.sandboxes.create(options), /ablation startup failure/); }
      finally { SandboxBuilderCore.prototype.start = original; }
    } else {
      sandbox = await wasmer.sandboxes.create(options);
      await writeFile(join(directory, 'hello.txt'), 'after');
      const result = await sandbox.command('node', ['/workspace/probe.cjs']).run({ timeoutMs: 8_000 });
      assert.equal(result.stdout.text().trim(), 'mount-ok');
      assert.deepEqual(await readFile(join(directory, 'result.bin')), Buffer.from([0, 128, 255]));
      const shell = await sandbox.command('bash', ['-lc', 'cat /mounted/hello.txt; printf shell-ok > /mounted/shell.txt']).run({ timeoutMs: 8_000 });
      assert.equal(shell.stdout.text(), 'after');
      assert.equal(await readFile(join(directory, 'shell.txt'), 'utf8'), 'shell-ok');
    }
  } finally {
    try { await sandbox?.close(); }
    finally {
      try { await wasmer.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
  const { hostFileSystemStats } = await import(sdkUrl('dist/node-host-filesystem.js'));
  assert.deepEqual(hostFileSystemStats(), { mounts: 0, handles: 0 });
}

async function tcpProbe() {
  let directConnections = 0;
  let proxyConnections = 0;
  const direct = net.createServer(socket => { directConnections++; socket.end('bypass'); });
  const proxy = net.createServer(socket => {
    proxyConnections++;
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.write(Buffer.from([5, 0]));
      socket.once('data', () => socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])));
    });
  });
  await listen(direct);
  await listen(proxy);
  const wasmer = client({ tcpProxy: { host: '127.0.0.1', port: proxy.address().port } });
  let sandbox;
  try {
    sandbox = await wasmer.sandboxes.create({
      packages: [await runtime(wasmer)], network: { mode: 'host' },
      env: { TARGET_PORT: String(direct.address().port) },
      files: { '/workspace/probe.cjs': `const socket = require('node:net').connect({host:'127.0.0.1', port:Number(process.env.TARGET_PORT)});
socket.on('error', () => console.log('denied'));
socket.on('data', data => console.log(data.toString()));
socket.on('connect', () => socket.end());` },
    });
    const result = await sandbox.command('node', ['/workspace/probe.cjs']).run({ timeoutMs: 8_000 });
    assert.equal(directConnections, 0, 'denied guest TCP reached the direct target');
    assert.ok(proxyConnections > 0, 'proxy did not observe guest TCP');
    assert.equal(result.stdout.text().trim(), 'denied', 'guest TCP must reach the denying proxy');
  } finally {
    await sandbox?.close(); await wasmer.close();
    await Promise.all([close(direct), close(proxy)]);
  }
}

async function dnsProbe() {
  const { NodeNetworkBridge } = await import(sdkUrl('dist/node-network.js'));
  const bridge = new NodeNetworkBridge({ host: '127.0.0.1', port: 1 });
  try {
    const aliases = await bridge.resolve('never-resolve-in-host.invalid');
    assert.equal(aliases.length, 2);
    assert.equal(net.isIP(aliases[0]), 4);
    assert.equal(net.isIP(aliases[1]), 6);
    assert.deepEqual(await bridge.resolve('never-resolve-in-host.invalid'), aliases);
  } finally { bridge.close(); }
}

async function listenerProbe() {
  const { NodeNetworkBridge } = await import(sdkUrl('dist/node-network.js'));
  const bridge = new NodeNetworkBridge({ host: '127.0.0.1', port: 1 });
  try { assert.throws(() => bridge.listenTcp('127.0.0.1:0'), /disabled/); }
  finally { bridge.close(); }
}

async function keepaliveProbe() {
  const certificate = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
  });
  const server = https.createServer({ key: certificate.private, cert: certificate.cert }, (_request, response) => response.end('fetch-ok'));
  server.on('tlsClientError', () => {});
  await listen(server);
  const wasmer = client();
  let sandbox;
  try {
    sandbox = await wasmer.sandboxes.create({
      packages: [await runtime(wasmer)], network: { mode: 'host' },
      env: { NODE_EXTRA_CA_CERTS: '/workspace/ca.pem', URL: `https://127.0.0.1:${server.address().port}/` },
      files: {
        '/workspace/ca.pem': certificate.cert,
        '/workspace/compat.cjs': await readFile(join(projectRoot, 'assets/edgejs-keepalive.cjs')),
        '/workspace/probe.cjs': `fetch(process.env.URL).then(r => r.text()).then(console.log).catch(e => { console.log(e.cause?.code || e.cause?.message || e.message); process.exitCode = 1; });`,
      },
    });
    const args = [...(probe === 'keepalive' ? ['--require', '/workspace/compat.cjs'] : []), '/workspace/probe.cjs'];
    const result = await sandbox.command('node', args).run({ timeoutMs: 8_000, check: false });
    assert.equal(result.stdout.text().trim(), 'fetch-ok', `native fetch result: ${result.stdout.text().trim()}`);
    assert.equal(result.exitCode, 0);
  } finally {
    await sandbox?.close(); await wasmer.close();
    server.closeAllConnections(); await close(server);
  }
}

async function fatalWorkerProbe() {
  const { NodeWorkerAdapter, subscribeWorkerFailures, nodeWorkerStats } = await import(sdkUrl('dist/node-worker-adapter.js'));
  assert.equal(typeof subscribeWorkerFailures, 'function', 'fatal-worker subscription is missing');
  let observed;
  const unsubscribe = subscribeWorkerFailures(error => { observed = error; });
  const worker = new NodeWorkerAdapter('data:text/javascript,throw new Error("ablation-fatal-worker")');
  try {
    for (let attempt = 0; attempt < 50 && nodeWorkerStats().activeWorkers; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(nodeWorkerStats().workerFailures, 1, 'fixture did not fail the nested SDK worker');
    assert.match(observed?.message ?? '', /ablation-fatal-worker/, 'SDK failure was not forwarded to its owner');
  } finally { unsubscribe(); worker.terminate(); }
}

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
function close(server) { return new Promise(resolve => server.close(resolve)); }
