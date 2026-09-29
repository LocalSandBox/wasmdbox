import net from 'node:net';
import { domainToASCII } from 'node:url';
import { once } from 'node:events';

export interface TcpProxyEndpoint {
  host: string;
  port: number;
}

// DNS aliases preserve the original hostname across WASIX's IP-only TCP ABI.
// Actual DNS resolution happens at the SOCKS proxy, never in the guest bridge.
export class SocksConnector {
  #endpoint: TcpProxyEndpoint;
  #names = new Map<string, string[]>();
  #addresses = new Map<string, string>();
  #pending = new Set<net.Socket>();
  #closed = false;

  constructor(options: TcpProxyEndpoint) {
    if (!options || !net.isIP(options.host) || !Number.isInteger(options.port)
        || options.port < 1 || options.port > 65535) {
      throw new TypeError('tcpProxy requires a literal IP host and port 1–65535');
    }
    this.#endpoint = { host: options.host, port: options.port };
  }

  resolve(input: unknown): string[] {
    if (this.#closed) throw new Error('TCP proxy bridge is closed');
    const host = normalizeHost(input);
    if (net.isIP(host)) return [host];
    if (!this.#names.has(host)) {
      const id = this.#names.size + 1;
      if (id >= 131071) throw new Error('TCP proxy DNS alias capacity exceeded');
      const v4 = `198.${18 + (id >>> 16)}.${(id >>> 8) & 255}.${id & 255}`;
      const v6 = normalizeHost(`fd00:7761:736d::${(id >>> 16).toString(16)}:${(id & 65535).toString(16)}`);
      this.#names.set(host, [v4, v6]);
      this.#addresses.set(v4, host);
      this.#addresses.set(v6, host);
    }
    return [...this.#names.get(host)!];
  }

  async connect(peer: TcpProxyEndpoint): Promise<net.Socket> {
    if (this.#closed) throw new Error('TCP proxy bridge is closed');
    const address = normalizeHost(peer.host);
    const host = this.#addresses.get(address) ?? address;
    if (host === address && /^(198\.(18|19)\.|fd00:7761:736d:)/.test(address)) {
      throw new Error('Unknown TCP proxy DNS alias');
    }
    const socket = net.createConnection({ ...this.#endpoint, allowHalfOpen: true });
    this.#pending.add(socket);
    // Retain ownership until close, including the handoff to NodeNetworkBridge.
    socket.once('close', () => this.#pending.delete(socket));
    // Keep errors handled even between asynchronous handshake steps.
    socket.on('error', () => {});
    const timeout = setTimeout(() => socket.destroy(new Error('SOCKS handshake timeout')), 10_000);
    try {
      await once(socket, 'connect');
      socket.write(Buffer.from([5, 1, 0]));
      const greeting = await readBytes(socket, 2);
      if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error('SOCKS authentication rejected');
      const port = Buffer.alloc(2);
      port.writeUInt16BE(peer.port);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), encodeAddress(host), port]));
      const reply = await readBytes(socket, 4);
      if (reply[0] !== 5 || reply[2] !== 0 || reply[1] !== 0) {
        throw new Error(`SOCKS connection rejected (${reply[1]})`);
      }
      await readAddress(socket, reply[3]);
      await readBytes(socket, 2);
      // readBytes leaves the socket paused and retains any post-handshake bytes.
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  close() {
    this.#closed = true;
    for (const socket of this.#pending) socket.destroy(new Error('TCP proxy bridge is closed'));
    this.#pending.clear();
    this.#names.clear();
    this.#addresses.clear();
  }
}

function normalizeHost(input: unknown): string {
  if (typeof input !== 'string') throw new TypeError('Invalid hostname');
  if (net.isIP(input) === 6) return new URL(`http://[${input}]/`).hostname.slice(1, -1);
  if (net.isIP(input)) return input;
  const host = domainToASCII(input.replace(/\.$/, '').toLowerCase());
  if (!host || host.length > 253 || !host.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new TypeError('Invalid hostname');
  }
  return host;
}

function encodeAddress(host: string): Buffer {
  if (net.isIP(host) === 4) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (net.isIP(host) === 6) {
    const [left, right] = host.split('::').map(part => part ? part.split(':') : []);
    const words = right ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    const bytes = Buffer.alloc(17);
    bytes[0] = 4;
    words.forEach((word, index) => bytes.writeUInt16BE(parseInt(word, 16), 1 + index * 2));
    return bytes;
  }
  const bytes = Buffer.from(host, 'ascii');
  return Buffer.concat([Buffer.from([3, bytes.length]), bytes]);
}

async function readAddress(socket: net.Socket, type: number): Promise<Buffer> {
  if (type === 1) return readBytes(socket, 4);
  if (type === 4) return readBytes(socket, 16);
  if (type === 3) {
    const length = (await readBytes(socket, 1))[0];
    if (!length) throw new Error('Invalid SOCKS bound address');
    return readBytes(socket, length);
  }
  throw new Error('Invalid SOCKS address type');
}

function readBytes(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    function cleanup() {
      socket.off('readable', read);
      socket.off('end', closed);
      socket.off('close', closed);
      socket.off('error', fail);
    }
    function fail(error: Error) { cleanup(); reject(error); }
    function closed() { fail(new Error('SOCKS connection closed during handshake')); }
    function read() {
      const data = socket.read(length);
      if (data !== null) { cleanup(); resolve(data); }
      else if (socket.destroyed || socket.readableEnded) closed();
    }
    socket.on('readable', read);
    socket.once('end', closed);
    socket.once('close', closed);
    socket.once('error', fail);
    read();
  });
}
