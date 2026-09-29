import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { generate } from 'selfsigned';
import { createPolicy, normalizeHost } from '../dist/internal/policy.js';
import { startProxy } from '../dist/internal/proxy.js';

test('domain wildcards, CIDR, deny precedence and resolved address filtering', () => {
  const addresses = [{ address: '10.1.2.3' }, { address: '10.2.1.1' }];
  const policy = createPolicy({ allow: ['*.example.test', '10.0.0.0/8', '2001:db8::/32'], deny: ['admin.example.test', '10.2.0.0/16'] });
  assert.deepEqual(policy.select('api.example.test', addresses), [{ address: '10.1.2.3', family: 4 }]);
  assert.throws(() => policy.select('admin.example.test', addresses), /denied/);
  assert.throws(() => policy.select('api.example.test', [{ address: '10.2.1.1' }]), /denied/);
  assert.equal(policy.select('2001:db8::1', [{ address: '2001:db8::1' }])[0].family, 6);
  assert.throws(() => policy.select('2001:db9::1', [{ address: '2001:db9::1' }]), /denied/);
  assert.throws(() => policy.select('::ffff:10.2.1.1', [{ address: '::ffff:10.2.1.1' }]), /denied/);
  const domains = createPolicy({ allow: ['*.example.test'] });
  for (const host of ['example.test', 'api.example.test.evil', '127.0.0.1', '::1']) {
    assert.throws(() => domains.select(host, [{ address: '127.0.0.1' }]), /denied/, host);
  }
  assert.equal(domains.select(normalizeHost('API.Example.Test.'), [{ address: '127.0.0.1' }]).length, 1);
  assert.throws(() => createPolicy({ deny: ['blocked.test'] }).checkHost('127.0.0.1'), /denied/);
  assert.equal(createPolicy().select('127.0.0.1', [{ address: '127.0.0.1' }]).length, 1);
  assert.throws(() => createPolicy({ allow: [] }).select('api.test', addresses), /denied/);
  for (const pattern of ['10.0.0.0/33', '::1/129', 'foo/bar', '*bad.test', '10.0.0.0/']) {
    assert.throws(() => createPolicy({ allow: [pattern] }));
  }
});

test('destination ports validate before opening a listener', async () => {
  for (const ports of [null, 443, '443', [0], [-1], [65536], [1.5], [NaN], [Infinity], ['443'], [undefined], Array(1)]) {
    await assert.rejects(startProxy({ ports }), { name: 'TypeError', message: 'Allowed ports must be integers from 1 to 65535' });
  }
});

test('destination port policy blocks other services on the same allowed host', async t => {
  let allowedConnections = 0;
  let blockedConnections = 0;
  const allowed = net.createServer(socket => { allowedConnections++; socket.resume(); });
  const blocked = net.createServer(socket => { blockedConnections++; socket.end(); });
  await listen(allowed);
  await listen(blocked);
  t.after(async () => { await close(allowed); await close(blocked); });
  const options = { allow: ['broker.test'], dns: { 'broker.test': ['127.0.0.1'] } };
  const allowedPort = allowed.address().port;
  const ports = [allowedPort];
  const proxy = await startProxy({ ...options, ports });
  t.after(() => proxy.close());
  // The policy snapshots caller input; later changes cannot widen it.
  ports.push(blocked.address().port);
  const connection = await connectSocks(proxy, 'broker.test', allowedPort);
  connection.destroy();
  await assert.rejects(connectSocks(proxy, 'broker.test', blocked.address().port));
  assert.equal(allowedConnections, 1);
  assert.equal(blockedConnections, 0);
  assert.equal(proxy.stats.denied, 1);
  const none = await startProxy({ ...options, ports: [] });
  try { await assert.rejects(connectSocks(none, 'broker.test', allowedPort)); }
  finally { await none.close(); }
  assert.equal(allowedConnections, 1);
  const unrestricted = await startProxy(options);
  try { (await connectSocks(unrestricted, 'broker.test', blocked.address().port)).destroy(); }
  finally { await unrestricted.close(); }
  assert.equal(blockedConnections, 1);
});

test('invalid secrets and DNS overrides reject before opening a listener', async () => {
  for (const secrets of [
    { 'bad=name': { value: 'value', hosts: ['api.test'] } },
    { NODE_OPTIONS: { value: 'value', hosts: ['api.test'] } },
    { NODE_EXTRA_CA_CERTS: { value: 'value', hosts: ['api.test'] } },
    { KEY: { value: 'value', hosts: [] } },
    { KEY: { value: 'value', hosts: ['127.0.0.1'] } },
    { KEY: { value: 'value', hosts: ['api.test'], ports: [0] } },
    { KEY: { value: 123, hosts: ['api.test'] } },
  ]) await assert.rejects(startProxy({ secrets }), TypeError);
  await assert.rejects(startProxy({ dns: { 'api.test': ['not-an-ip'] } }), TypeError);
});

test('secrets MITM: scoped substitution, body framing, TLS identity and fail-closed policy', { timeout: 60_000 }, async t => {
  const names = ['api.test', 'docs.test', 'one.example.test', 'two.example.test', 'blocked.test'];
  const certificate = await generate([{ name: 'commonName', value: 'api.test' }], {
    keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: names.map(value => ({ type: 2, value })) }],
  });
  const seen = [];
  let responseBody = Buffer.from('unchanged-response');
  const fixture = https.createServer({ key: certificate.private, cert: certificate.cert }, (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': responseBody.length });
      res.end(responseBody);
    });
  });
  fixture.on('tlsClientError', () => {});
  await listen(fixture);
  const port = fixture.address().port;
  const options = {
    allow: ['api.test', 'docs.test', '*.example.test', '127.0.0.0/8'], deny: ['blocked.test'], ports: [port],
    secrets: {
      API_TOKEN: { value: 'host-only-secret', hosts: ['api.test', '*.example.test', 'blocked.test'], ports: [port] },
      WRONG_PORT: { value: 'different-port-secret', hosts: ['api.test'] },
    },
    dns: Object.fromEntries(names.map(name => [name, ['127.0.0.1']])), caCerts: [certificate.cert],
  };
  const proxy = await startProxy(options);
  t.after(async () => { await proxy.close(); fixture.closeAllConnections(); await close(fixture); });
  const request = (extra = {}) => requestTLS(proxy, { host: 'api.test', port, ca: proxy.caCert, ...extra });
  const token = proxy.env.API_TOKEN;
  assert.match(token, /^sandbox-[a-f0-9]{120}$/);
  assert.equal(token.length, 128);
  assert.equal(JSON.stringify(proxy).includes('host-only-secret'), false);

  await t.test('raw path/query, ordinary headers and split binary body are substituted once', async () => {
    const body = Buffer.concat([Buffer.from([255, 0]), Buffer.from(token), Buffer.from([128, 10])]);
    const result = await request({
      method: 'POST', path: `/v1/${token}?key=${token}`,
      headers: `Authorization: Bearer ${token}\r\nX-Unmatched: ${proxy.env.WRONG_PORT}\r\nContent-Type: application/${token}\r\n`,
      chunks: [body.subarray(0, 65), body.subarray(65)],
    });
    assert.equal(result.status, 200);
    const actual = seen.at(-1);
    assert.equal(actual.path, '/v1/host-only-secret?key=host-only-secret');
    assert.equal(actual.headers.authorization, 'Bearer host-only-secret');
    assert.equal(actual.headers['x-unmatched'], proxy.env.WRONG_PORT);
    assert.equal(actual.headers['content-type'], `application/${token}`);
    assert.equal(actual.headers['content-length'], undefined);
    assert.equal(actual.headers['transfer-encoding'], 'chunked');
    assert.deepEqual(actual.body, Buffer.concat([Buffer.from([255, 0]), Buffer.from('host-only-secret'), Buffer.from([128, 10])]));
  });

  await t.test('content-length is rebuilt when a plain body changes length', async () => {
    assert.equal((await request({ method: 'POST', body: Buffer.from(token) })).status, 200);
    assert.equal(seen.at(-1).body.toString(), 'host-only-secret');
    assert.equal(seen.at(-1).headers['content-length'], undefined);
    assert.equal(seen.at(-1).headers['transfer-encoding'], 'chunked');
  });

  await t.test('compressed bodies are not decoded or scanned, and responses are unchanged', async () => {
    // Stored DEFLATE blocks contain the literal token, so scanning compressed
    // bytes would corrupt this otherwise valid gzip payload.
    const body = gzipSync(Buffer.from(token), { level: 0 });
    assert.ok(body.includes(Buffer.from(token)));
    responseBody = Buffer.concat([Buffer.from([255, 0]), Buffer.from(token), Buffer.from('host-only-secret')]);
    const result = await request({ method: 'POST', headers: 'Content-Encoding: gzip\r\n', body });
    assert.equal(result.status, 200);
    assert.deepEqual(seen.at(-1).body, body);
    assert.equal(seen.at(-1).headers['content-length'], String(body.length));
    assert.deepEqual(result.body, responseBody);
  });

  await t.test('wildcard leaves are generated for each authorized origin; tokens stay stable', async () => {
    for (const host of ['one.example.test', 'two.example.test']) {
      assert.equal((await request({ host, headers: `X-Key: ${token}\r\n` })).status, 200);
      assert.equal(seen.at(-1).headers['x-key'], 'host-only-secret');
    }
    assert.equal(proxy.env.API_TOKEN, token);
  });

  await t.test('unmatched origin passes through unchanged without a proxy-issued certificate', async () => {
    const before = proxy.stats.mitm;
    assert.equal((await request({ host: 'docs.test', ca: certificate.cert, headers: `X-Key: ${token}\r\n` })).status, 200);
    assert.equal(seen.at(-1).headers['x-key'], token);
    assert.equal(proxy.stats.mitm, before);
    assert.ok(proxy.stats.tunnels > 0);
  });

  await t.test('each proxy has independent tokens and a token from another proxy is inert', async () => {
    const other = await startProxy(options);
    try {
      assert.notEqual(other.env.API_TOKEN, token);
      assert.equal((await request({ headers: `X-Key: ${other.env.API_TOKEN}\r\n` })).status, 200);
      assert.equal(seen.at(-1).headers['x-key'], other.env.API_TOKEN);
    } finally { await other.close(); }
  });

  await t.test('secrets do not widen policy; denied resolved CIDRs still win', async () => {
    const before = seen.length;
    await assert.rejects(connectSocks(proxy, 'blocked.test', port));
    const denied = await startProxy({ ...options, deny: ['127.0.0.0/8'] });
    try { await assert.rejects(connectSocks(denied, 'api.test', port)); }
    finally { await denied.close(); }
    assert.equal(seen.length, before);
  });

  await t.test('secret ports cannot widen the destination-port allowlist', async () => {
    const before = seen.length;
    const denied = await startProxy({ ...options, ports: [] });
    try { await assert.rejects(connectSocks(denied, 'api.test', port)); }
    finally { await denied.close(); }
    assert.equal(seen.length, before);
  });

  await t.test('SNI, Host, duplicate Host and request-target mismatches cannot receive secrets', async () => {
    const before = seen.length;
    await assert.rejects(request({ ca: undefined }));
    await assert.rejects(request({ servername: 'docs.test' }));
    await assert.rejects(request({ servername: '' }));
    await assert.rejects(request({ protocols: ['h2'] }));
    assert.equal((await request({ authority: `docs.test:${port}` })).status, 403);
    assert.equal((await request({ headers: `Host: api.test:${port}\r\n` })).status, 403);
    assert.equal((await request({ path: 'https://docs.test/demo' })).status, 403);
    assert.equal(seen.length, before);
  });

  await t.test('upstream TLS stays verified even when the guest trusts the proxy CA', async () => {
    const before = seen.length;
    const untrusted = await startProxy({ ...options, caCerts: [] });
    try {
      assert.equal((await requestTLS(untrusted, { host: 'api.test', port, ca: untrusted.caCert })).status, 502);
    } finally { await untrusted.close(); }
    assert.equal(seen.length, before);
  });

  await t.test('closing the proxy rejects future direct-IP connections without fallback', async () => {
    await proxy.close();
    await assert.rejects(connectSocks(proxy, '127.0.0.1', port));
  });
});

test('raw IPv4/IPv6 TCP, binary data and half-close pass through; close clears pending and active sockets', async t => {
  const proxy = await startProxy({ allow: ['127.0.0.0/8', '::1/128'] });
  t.after(() => proxy.close());
  for (const host of ['127.0.0.1', '::1']) {
    const echo = net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket));
    await listen(echo, host);
    try {
      const socket = await connectSocks(proxy, host, echo.address().port);
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      const ended = once(socket, 'end');
      const input = Buffer.alloc(128 * 1024, 173);
      socket.end(input);
      socket.resume();
      await ended;
      assert.deepEqual(Buffer.concat(chunks), input);
      socket.destroy();
    } finally { await close(echo); }
  }
  assert.equal(proxy.stats.tunnels, 2);
  const activeServer = net.createServer(socket => socket.on('error', () => {}));
  await listen(activeServer);
  const active = await connectSocks(proxy, '127.0.0.1', activeServer.address().port);
  const activeClosed = new Promise(resolve => active.once('close', resolve));
  active.resume();
  const pending = net.createConnection({ host: proxy.host, port: proxy.port });
  pending.on('error', () => {});
  await once(pending, 'connect');
  const stopped = new Promise(resolve => pending.once('close', resolve));
  pending.write(Buffer.from([5]));
  await proxy.close();
  await Promise.all([stopped, activeClosed]);
  await close(activeServer);
});

test('fatal listener errors notify the owner once and close the proxy', async t => {
  const original = net.createServer;
  let listener;
  const stub = t.mock.method(net, 'createServer', (...args) => { listener = original(...args); return listener; });
  const errors = [];
  const proxy = await startProxy({}, error => errors.push(error));
  stub.mock.restore();
  const failure = new Error('injected listener failure');
  listener.emit('error', failure);
  listener.emit('error', new Error('later failure'));
  await proxy.close();
  assert.deepEqual(errors, [failure]);
  await assert.rejects(connectSocks(proxy, '127.0.0.1', 443));
});

async function requestTLS(proxy, { host, port, ca, servername = host, authority = `${host}:${port}`, protocols = ['http/1.1'], path = '/demo', method = 'GET', headers = '', body = Buffer.alloc(0), chunks }) {
  const transport = await connectSocks(proxy, host, port);
  const socket = tls.connect({ socket: transport, servername, ca, rejectUnauthorized: true, ALPNProtocols: protocols });
  socket.setTimeout(5000, () => socket.destroy(new Error('TLS request timed out')));
  try {
    await once(socket, 'secureConnect');
    const received = [];
    socket.on('data', chunk => received.push(chunk));
    const ended = once(socket, 'end');
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n${headers}${chunks ? 'Transfer-Encoding: chunked' : `Content-Length: ${body.length}`}\r\n\r\n`);
    if (chunks) {
      for (const chunk of chunks) { socket.write(`${chunk.length.toString(16)}\r\n`); socket.write(chunk); socket.write('\r\n'); }
      socket.write('0\r\n\r\n');
    } else socket.write(body);
    await ended;
    const response = Buffer.concat(received);
    const split = response.indexOf('\r\n\r\n');
    if (split === -1) throw new Error('TLS connection closed without HTTP response');
    return { status: Number(response.toString('latin1', 0, split).split(' ')[1]), body: response.subarray(split + 4) };
  } finally { socket.destroy(); }
}

async function connectSocks(proxy, host, port) {
  const socket = net.createConnection({ host: proxy.host, port: proxy.port });
  socket.on('error', () => {});
  socket.setTimeout(5000, () => socket.destroy(new Error('SOCKS test timeout')));
  try {
    await once(socket, 'connect');
    socket.write(Buffer.from([5, 1, 0]));
    assert.deepEqual(await readBytes(socket, 2), Buffer.from([5, 0]));
    const name = Buffer.from(host);
    const number = Buffer.alloc(2); number.writeUInt16BE(port);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, number]));
    const result = await readBytes(socket, 10);
    if (result[1] !== 0) throw new Error('SOCKS target denied');
    socket.setTimeout(0);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

function readBytes(socket, length) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('readable', read); socket.off('close', closed); socket.off('end', closed); socket.off('error', fail); };
    const fail = error => { cleanup(); reject(error); };
    const closed = () => fail(new Error('SOCKS connection closed'));
    const read = () => { const bytes = socket.read(length); if (bytes !== null) { cleanup(); resolve(bytes); } };
    socket.on('readable', read); socket.once('close', closed); socket.once('end', closed); socket.once('error', fail); read();
  });
}
function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }
