import net from 'node:net';
import dns from 'node:dns/promises';
import tls from 'node:tls';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { generate } from 'selfsigned';
import { createPolicy, normalizeHost, compileDomainPattern, type ResolvedAddress } from './policy.js';
import { SecretReplacer, replaceSecrets, type SecretReplacement } from './secret-replacer.js';

export interface NetworkOptions {
  allow?: readonly string[];
  deny?: readonly string[];
  secrets?: Readonly<Record<string, {
    value: string;
    hosts: readonly string[];
    ports?: readonly number[];
  }>>;
  dns?: Readonly<Record<string, readonly string[]>>;
  caCerts?: readonly string[];
}

export interface ProxyStats {
  connections: number;
  tunnels: number;
  mitm: number;
  denied: number;
  requests: number;
}

export interface ProxyHandle {
  host: string;
  port: number;
  caCert?: string;
  env: Record<string, string>;
  stats: ProxyStats;
  close(): Promise<void>;
}

interface SecretRule extends SecretReplacement {
  matches(host: string, port: number): boolean;
}

interface Target {
  host: string;
  port: number;
  addresses: ResolvedAddress[];
  replacements: readonly SecretReplacement[];
}

type TargetSocket = tls.TLSSocket & { proxyTarget?: Target };
type Leaf = { key: string; cert: string };
const MAX_LEAF_CERTIFICATES = 128;

/** All secret values and CA private keys remain in this host-side closure. */
export async function startProxy(options: NetworkOptions = {}, onFatal?: (error: Error) => void): Promise<ProxyHandle> {
  const access = createPolicy(options);
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  const secrets: SecretRule[] = Object.entries(options.secrets ?? {}).map(([name, secret]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError('Invalid secret environment variable name');
    if (name === 'NODE_OPTIONS' || name === 'NODE_EXTRA_CA_CERTS') {
      throw new TypeError('Secret names cannot replace managed Node environment variables');
    }
    if (!secret || typeof secret.value !== 'string' || !Array.isArray(secret.hosts) || !secret.hosts.length) {
      throw new TypeError('Secrets require a string value and nonempty hosts');
    }
    const hosts = secret.hosts.map(compileDomainPattern);
    const ports = [...(secret.ports ?? [443])];
    if (!ports.every(validPort)) throw new TypeError('Secret ports must be integers from 1 to 65535');
    const token = `sandbox-${randomBytes(60).toString('hex')}`;
    env[name] = token;
    return {
      token: Buffer.from(token), value: Buffer.from(secret.value),
      matches: (host, port) => ports.includes(port) && hosts.some(matches => matches(host)),
    };
  });
  const overrides = new Map<string, ResolvedAddress[]>();
  for (const [input, values] of Object.entries(options.dns ?? {})) {
    const host = normalizeHost(input);
    if (!Array.isArray(values) || !values.length || values.some(value => !net.isIP(value))) {
      throw new TypeError('DNS overrides require nonempty arrays of IP addresses');
    }
    if (overrides.has(host)) throw new TypeError('Duplicate normalized DNS override');
    overrides.set(host, values.map(address => ({ address: normalizeHost(address), family: net.isIP(address) as 4 | 6 })));
  }
  if (options.caCerts?.some(cert => typeof cert !== 'string')) throw new TypeError('CA certificates must be strings');
  const upstreamCAs = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system'), ...(options.caCerts ?? [])])];
  const sockets = new Set<net.Socket>();
  const leaves = new Map<string, { promise: Promise<Leaf>; ready: boolean }>();
  const stats: ProxyStats = { connections: 0, tunnels: 0, mitm: 0, denied: 0, requests: 0 };
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let listening = false;
  let fatalReported = false;
  const ca = secrets.length ? await generate([{ name: 'commonName', value: 'wasmdbox secrets proxy CA' }], {
    keySize: 2048, algorithm: 'sha256', notAfterDate: tomorrow(),
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  }) : undefined;

  const httpServer = http.createServer({ maxHeaderSize: 16 * 1024 }, forward);
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;
  httpServer.on('clientError', (_error, socket) => socket.destroy());
  httpServer.on('connect', (_request, socket) => socket.destroy());
  httpServer.on('upgrade', (_request, socket) => socket.destroy());
  httpServer.on('error', reportFatal);
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    track(socket);
    stats.connections++;
    void accept(socket).catch(() => { stats.denied++; socket.destroy(); });
  });
  server.on('error', error => { if (listening) reportFatal(error); });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', started); reject(error); };
    const started = () => { server.off('error', failed); listening = true; resolve(); };
    server.once('error', failed);
    server.once('listening', started);
    server.listen(0, '127.0.0.1');
  });
  return { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, caCert: ca?.cert, env, stats, close };

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    for (const socket of sockets) socket.destroy();
    leaves.clear();
    closePromise = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return closePromise;
  }

  function reportFatal(error: Error): void {
    if (closing || fatalReported) return;
    fatalReported = true;
    void close().catch(() => {});
    try { onFatal?.(error); } catch { /* The owner must not prevent resource cleanup. */ }
  }

  function track<T extends net.Socket>(socket: T): T {
    if (closing) { socket.destroy(); return socket; }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  }

  async function leafFor(host: string): Promise<Leaf> {
    if (closing || !ca) throw new Error('Secrets proxy is closed');
    const cached = leaves.get(host);
    if (cached) { leaves.delete(host); leaves.set(host, cached); return cached.promise; }
    if (leaves.size >= MAX_LEAF_CERTIFICATES) {
      // Never evict an in-flight generation: concurrent certificate work is bounded too.
      const evict = [...leaves].find(([, entry]) => entry.ready)?.[0];
      if (evict === undefined) throw new Error('Certificate cache is busy');
      leaves.delete(evict);
    }
    const entry = { promise: Promise.resolve({ key: '', cert: '' }), ready: false };
    entry.promise = generate([{ name: 'commonName', value: host }], {
      keySize: 2048, algorithm: 'sha256', notAfterDate: tomorrow(), ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
      ],
    }).then(certificate => { entry.ready = true; return { key: certificate.private, cert: certificate.cert }; }, error => {
      if (leaves.get(host) === entry) leaves.delete(host);
      throw error;
    });
    leaves.set(host, entry);
    return entry.promise;
  }

  async function accept(socket: net.Socket): Promise<void> {
    const timer = setTimeout(() => socket.destroy(), 10_000);
    try {
      const greeting = await readBytes(socket, 2);
      if (greeting[0] !== 5 || greeting[1] === 0) throw new Error('Invalid SOCKS greeting');
      const methods = await readBytes(socket, greeting[1]);
      if (!methods.includes(0)) { socket.end(Buffer.from([5, 255])); return; }
      socket.write(Buffer.from([5, 0]));
      const request = await readBytes(socket, 4);
      if (request[0] !== 5 || request[1] !== 1 || request[2] !== 0) { socket.end(reply(7)); return; }
      const host = normalizeHost(await readHost(socket, request[3]));
      const port = (await readBytes(socket, 2)).readUInt16BE();
      if (!validPort(port)) throw new Error('Invalid port');
      access.checkHost(host);
      const resolved = net.isIP(host) ? [{ address: host }] : overrides.get(host) ?? await dns.lookup(host, { all: true });
      const addresses = access.select(host, resolved);
      if (closing || socket.destroyed) return;
      const replacements = secrets.filter(secret => secret.matches(host, port));
      const target: Target = { host, port, addresses, replacements };
      if (replacements.length) {
        const leaf = await leafFor(host);
        if (closing || socket.destroyed) return;
        stats.mitm++;
        socket.write(reply(0));
        terminateTLS(socket, target, leaf);
      } else {
        const upstream = track(net.createConnection({
          host, port, lookup: pinnedLookup(addresses), autoSelectFamily: true, allowHalfOpen: true,
        }));
        socket.once('close', () => upstream.destroy());
        upstream.once('close', () => socket.destroy());
        await once(upstream, 'connect');
        if (closing || socket.destroyed) { upstream.destroy(); return; }
        stats.tunnels++;
        socket.write(reply(0));
        socket.pipe(upstream).pipe(socket);
      }
    } finally { clearTimeout(timer); }
  }

  function terminateTLS(socket: net.Socket, target: Target, leaf: Leaf): void {
    const context = tls.createSecureContext(leaf);
    const tlsServer = tls.createServer({
      ...leaf, ALPNProtocols: ['http/1.1'], handshakeTimeout: 10_000,
      SNICallback(name, callback) {
        try {
          if (normalizeHost(name) !== target.host) throw new Error('SNI does not match target');
          callback(null, context);
        } catch (error) { callback(error as Error); }
      },
    }, secured => {
      track(secured);
      secured.setTimeout(30_000, () => secured.destroy());
      if (!secured.servername || normalizeHost(secured.servername) !== target.host
          || (secured.alpnProtocol && secured.alpnProtocol !== 'http/1.1')) { secured.destroy(); return; }
      (secured as TargetSocket).proxyTarget = target;
      httpServer.emit('connection', secured);
    });
    tlsServer.on('tlsClientError', (_error, secured) => secured.destroy());
    tlsServer.on('error', reportFatal);
    tlsServer.emit('connection', socket);
  }

  function forward(request: http.IncomingMessage, response: http.ServerResponse): void {
    const target = (request.socket as TargetSocket).proxyTarget;
    const fail = (status: number) => {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { connection: 'close' });
      response.end();
    };
    try {
      const hostCount = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length;
      if (closing || !target || hostCount !== 1 || !validAuthority(request.headers.host, target)
          || !request.url?.startsWith('/') || request.url.startsWith('//')) { stats.denied++; fail(403); return; }
      const headers = stripHopHeaders(request.headers);
      for (const [name, value] of Object.entries(headers)) {
        if (IMMUTABLE_HEADERS.has(name) || value === undefined) continue;
        const replace = (text: string) => replaceSecrets(Buffer.from(text, 'latin1'), target.replacements).toString('latin1');
        headers[name] = Array.isArray(value) ? value.map(replace) : replace(value);
      }
      headers.host = `${target.host}${target.port === 443 ? '' : `:${target.port}`}`;
      const compressed = request.headers['content-encoding'] !== undefined
        && request.headers['content-encoding'].trim().toLowerCase() !== 'identity';
      const chunked = request.headers['transfer-encoding'] !== undefined;
      const hasBody = chunked || Number(request.headers['content-length'] ?? 0) > 0;
      const replaceBody = hasBody && !compressed;
      if (replaceBody) delete headers['content-length'];
      if (chunked || replaceBody) headers['transfer-encoding'] = 'chunked';
      const upstreamOptions: https.RequestOptions & { autoSelectFamily: boolean; ALPNProtocols: string[] } = {
        hostname: target.host, port: target.port, servername: target.host,
        lookup: pinnedLookup(target.addresses), autoSelectFamily: true,
        ca: upstreamCAs, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'],
        agent: false, method: request.method,
        path: replaceSecrets(Buffer.from(request.url, 'latin1'), target.replacements).toString('latin1'), headers,
      };
      const upstream = https.request(upstreamOptions, incoming => {
        response.writeHead(incoming.statusCode ?? 502, stripHopHeaders(incoming.headers));
        incoming.on('error', () => response.destroy());
        incoming.on('aborted', () => response.destroy());
        incoming.pipe(response);
      });
      stats.requests++;
      upstream.on('socket', track);
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('Upstream timeout')));
      upstream.on('error', () => fail(502));
      upstream.on('upgrade', (_incoming, upgraded) => { upgraded.destroy(); fail(502); });
      request.on('aborted', () => upstream.destroy());
      request.on('error', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      if (replaceBody) {
        const replacement = new SecretReplacer(target.replacements);
        replacement.on('error', () => { upstream.destroy(); fail(502); });
        request.pipe(replacement).pipe(upstream);
      } else request.pipe(upstream);
    } catch { stats.denied++; fail(403); }
  }
}

const HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
// Routing, framing and representation metadata must never become secret-bearing data.
const IMMUTABLE_HEADERS = new Set([
  ...HOP_HEADERS, 'host', 'content-length', 'content-encoding', 'content-type',
  'accept-encoding', 'expect', 'range', 'content-range', 'if-range',
]);

function stripHopHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set([...HOP_HEADERS, ...(input.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(input).filter(([name]) => !excluded.has(name)));
}

function validAuthority(value: string | undefined, target: Target): boolean {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(value)) return false;
  const [host, port] = value.split(':');
  return normalizeHost(host) === target.host && Number(port ?? 443) === target.port;
}

function pinnedLookup(addresses: readonly ResolvedAddress[]): NonNullable<net.TcpNetConnectOpts['lookup']> {
  // Node has overloads for single/all-address lookup callbacks at this protocol boundary.
  return ((_host: string, options: { family?: number; all?: boolean }, callback: (...args: any[]) => void) => {
    const candidates = options.family ? addresses.filter(item => item.family === options.family) : addresses;
    if (!candidates.length) { callback(new Error('No allowed address for this family')); return; }
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  }) as NonNullable<net.TcpNetConnectOpts['lookup']>;
}

function validPort(port: number): boolean { return Number.isInteger(port) && port > 0 && port <= 65535; }
function tomorrow(): Date { return new Date(Date.now() + 24 * 60 * 60 * 1000); }
function reply(code: number): Buffer { return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]); }

async function readHost(socket: net.Socket, type: number): Promise<string> {
  if (type === 1) return [...await readBytes(socket, 4)].join('.');
  if (type === 4) {
    const bytes = await readBytes(socket, 16);
    return Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(':');
  }
  if (type === 3) {
    const length = (await readBytes(socket, 1))[0];
    if (!length) throw new Error('Empty hostname');
    const bytes = await readBytes(socket, length);
    if (bytes.some(byte => byte > 127)) throw new Error('SOCKS domains must use ASCII/IDNA');
    return bytes.toString('ascii');
  }
  throw new Error('Unsupported address type');
}

function readBytes(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    function cleanup() {
      socket.off('readable', read); socket.off('error', fail);
      socket.off('end', closed); socket.off('close', closed);
    }
    function fail(error: Error) { cleanup(); reject(error); }
    function closed() { fail(new Error('Incomplete SOCKS frame')); }
    function read() {
      const bytes: Buffer | null = socket.read(length);
      if (bytes !== null) { cleanup(); resolve(bytes); }
      else if (socket.destroyed || socket.readableEnded) closed();
    }
    socket.on('readable', read); socket.once('error', fail);
    socket.once('end', closed); socket.once('close', closed);
    read();
  });
}
