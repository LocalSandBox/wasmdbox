import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import https from 'node:https';
import { generate } from 'selfsigned';
import { Sandbox } from 'wasmdbox';

test('public Sandbox real WASM: Node/Bash fetch, scoped secrets, TCP, DNS and policy', { timeout: 240_000 }, async t => {
  const certificate = await generate([{ name: 'commonName', value: 'api.test' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [
      ...['api.test', 'docs.test', 'blocked.test'].map(value => ({ type: 2, value })), { type: 7, ip: '127.0.0.1' },
    ] }],
  });
  const firstSecret = 'first-host-only-test-credential';
  const secondSecret = 'second-host-only-test-credential';
  const seen = [];
  let upstreamConnections = 0;
  let httpsPort;
  const fixture = https.createServer({ key: certificate.private, cert: certificate.cert }, (request, response) => {
    const authorization = request.headers.authorization;
    const record = {
      credential: authorization === `Bearer ${firstSecret}` ? 'first'
        : authorization === `Bearer ${secondSecret}` ? 'second'
          : authorization?.startsWith('Bearer sandbox-') ? 'placeholder' : 'none',
      hasAuthorization: authorization !== undefined,
    };
    seen.push(record);
    if (request.url === '/redirect') {
      response.writeHead(302, { location: `https://docs.test:${httpsPort}/demo` });
      response.end();
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(record));
    }
  });
  fixture.on('connection', () => upstreamConnections++);
  fixture.on('tlsClientError', () => {});
  await listen(fixture);
  httpsPort = fixture.address().port;
  const echo4 = net.createServer(socket => socket.pipe(socket));
  const echo6 = net.createServer(socket => socket.pipe(socket));
  await listen(echo4);
  await listen(echo6, '::1');
  let echoes = 0;
  echo4.on('connection', () => echoes++);
  echo6.on('connection', () => echoes++);
  const unused = net.createServer();
  await listen(unused);
  const closedPort = unused.address().port;
  await close(unused);
  const boxes = new Set();
  t.after(async () => {
    const results = await Promise.allSettled([...boxes].map(box => box.close()));
    fixture.closeAllConnections();
    await Promise.all([close(fixture), close(echo4), close(echo6)]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Closing test sandboxes failed');
  });
  const source = await readFile(new URL('./fixtures/proxy-guest.cjs', import.meta.url));
  const network = {
    allow: ['api.test', 'docs.test', '127.0.0.0/8', '::1/128'], deny: ['blocked.test'],
    secrets: { API_KEY: { value: firstSecret, hosts: ['api.test'], ports: [httpsPort] } },
    dns: Object.fromEntries(['api.test', 'docs.test', 'blocked.test'].map(host => [host, ['127.0.0.1']])),
    caCerts: [certificate.cert],
  };
  async function create(networkOptions) {
    const box = await Sandbox.create({
      cacheDir: fileURLToPath(new URL('../.wasmer/', import.meta.url)),
      files: { '/workspace/probe.cjs': source },
      network: networkOptions,
      startupTimeoutMs: 180_000,
    });
    boxes.add(box);
    return box;
  }
  async function withSandbox(networkOptions, inspect) {
    const box = await create(networkOptions);
    try { return await inspect(box); }
    finally { await box.close(); boxes.delete(box); }
  }
  async function run(box, config, { bash = false, env = {} } = {}) {
    const result = await box.exec(bash ? ['bash', '-c', 'node /workspace/probe.cjs'] : ['node', '/workspace/probe.cjs'], {
      timeoutMs: 20_000, outputBytes: 128 * 1024, check: true,
      env: { ...env, PROBE_CONFIG: JSON.stringify(config) },
    });
    assert.equal(result.stderr, '');
    assert.equal(result.stdoutTruncated || result.stderrTruncated, false);
    return JSON.parse(result.stdout);
  }
  const sandbox = await create(network);
  const fetchConfig = { action: 'fetch', url: `https://api.test:${httpsPort}/demo` };
  let firstToken;

  await t.test('native fetch receives automatic trust and preload for direct Node and Bash child Node', async () => {
    for (const bash of [false, true]) {
      const result = await run(sandbox, fetchConfig, { bash });
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.body).credential, 'first');
      assert.match(result.guestToken, /^sandbox-[a-f0-9]{120}$/);
      assert.equal(JSON.stringify(result).includes(firstSecret), false);
      if (firstToken === undefined) firstToken = result.guestToken;
      else assert.equal(result.guestToken, firstToken);
    }
  });

  await t.test('per-command environment cannot overwrite managed secret placeholders', async () => {
    const result = await run(sandbox, fetchConfig, { env: { API_KEY: 'guest-override' } });
    assert.equal(result.guestToken, firstToken);
    assert.equal(JSON.parse(result.body).credential, 'first');
  });

  await t.test('unmatched origin receives only its placeholder; cross-origin redirect receives no authorization', async () => {
    const direct = await run(sandbox, { action: 'fetch', url: `https://docs.test:${httpsPort}/demo` });
    assert.equal(direct.status, 200);
    assert.equal(JSON.parse(direct.body).credential, 'placeholder');
    const redirected = await run(sandbox, { action: 'fetch', url: `https://api.test:${httpsPort}/redirect` });
    assert.equal(redirected.status, 200);
    assert.equal(JSON.parse(redirected.body).hasAuthorization, false);
    assert.equal(seen.at(-2).credential, 'first');
  });

  await t.test('raw IPv4 and IPv6 sockets obey the managed network path', async () => {
    const before = echoes;
    for (const [host, server] of [['127.0.0.1', echo4], ['::1', echo6]]) {
      const result = await run(sandbox, { action: 'tcp', host, port: server.address().port });
      assert.equal(result.body, 'guest-tcp');
      assert.equal(result.error, undefined);
    }
    assert.equal(echoes - before, 2);
  });

  await t.test('keepalive modes, repeated calls and failed connect complete with listener cleanup', async () => {
    const results = await run(sandbox, { action: 'keepalive', host: '127.0.0.1', port: echo4.address().port, closedPort });
    for (const result of results.slice(0, -1)) {
      assert.equal(result.error, undefined, result.mode);
      assert.equal(result.body, 'guest-tcp', result.mode);
      assert.equal(result.connectListeners, 0, result.mode);
    }
    assert.ok(results.at(-1).error);
    assert.equal(results.at(-1).connectListeners, 1, 'only the guest own pending listener remains after failed connect');
  });

  await t.test('deny-domain, omitted network and empty allow prevent upstream connections', async () => {
    const before = upstreamConnections;
    const beforeEcho = echoes;
    assert.ok((await run(sandbox, { action: 'fetch', url: `https://blocked.test:${httpsPort}/demo` })).error);
    await withSandbox(undefined, async disabled => {
      assert.ok((await run(disabled, fetchConfig)).error);
      assert.ok((await run(disabled, { action: 'tcp', host: '127.0.0.1', port: echo4.address().port })).error);
    });
    await withSandbox({ allow: [] }, async denied => {
      for (const [host, server] of [['127.0.0.1', echo4], ['::1', echo6]]) {
        assert.ok((await run(denied, { action: 'tcp', host, port: server.address().port })).error);
      }
    });
    assert.equal(upstreamConnections, before);
    assert.equal(echoes, beforeEcho);
  });

  await t.test('DNS overrides cannot bypass a denied resolved CIDR', async () => {
    const before = upstreamConnections;
    await withSandbox({ ...network, deny: ['127.0.0.0/8'] }, async denied => {
      assert.ok((await run(denied, fetchConfig)).error);
    });
    assert.equal(upstreamConnections, before);
  });

  await t.test('upstream TLS remains verified independently of guest trust in the proxy CA', async () => {
    const before = seen.length;
    await withSandbox({ ...network, caCerts: [] }, async untrusted => {
      const result = await run(untrusted, fetchConfig);
      assert.equal(result.status, 502);
    });
    assert.equal(seen.length, before);
  });

  await t.test('guest direct listener and UDP are unavailable', async () => {
    assert.ok((await run(sandbox, { action: 'listen', port: closedPort })).error);
    assert.ok((await run(sandbox, { action: 'udp', host: '127.0.0.1', port: closedPort })).error);
  });

  await t.test('separate sandboxes have independent credentials and cannot redeem each other tokens', async () => {
    await withSandbox({ ...network, secrets: { API_KEY: { value: secondSecret, hosts: ['api.test'], ports: [httpsPort] } } }, async other => {
      const second = await run(other, fetchConfig);
      assert.notEqual(second.guestToken, firstToken);
      assert.equal(JSON.parse(second.body).credential, 'second');
      assert.equal(JSON.stringify(second).includes(secondSecret), false);
      const cross = await run(other, { ...fetchConfig, headers: { authorization: `Bearer ${firstToken}` } });
      assert.equal(JSON.parse(cross.body).credential, 'placeholder');
      const firstAgain = await run(sandbox, fetchConfig, { bash: true });
      assert.equal(firstAgain.guestToken, firstToken);
      assert.equal(JSON.parse(firstAgain.body).credential, 'first');
    });
    assert.equal(JSON.parse((await run(sandbox, fetchConfig)).body).credential, 'first');
  });
});

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }
