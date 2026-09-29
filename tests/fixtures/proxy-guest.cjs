'use strict';
const net = require('node:net');
const config = JSON.parse(process.env.PROBE_CONFIG);

async function main() {
  if (config.action === 'fetch') {
    const response = await fetch(config.url, {
      headers: config.headers ?? { authorization: `Bearer ${process.env.API_KEY}` },
    });
    return { status: response.status, body: await response.text(), guestToken: process.env.API_KEY };
  }
  if (config.action === 'tcp') return tcp(config);
  if (config.action === 'keepalive') {
    const results = [];
    for (const mode of ['before-connect', 'connecting', 'repeated', 'connected', 'failed']) {
      results.push(await tcp({ ...config, mode, port: mode === 'failed' ? config.closedPort : config.port }));
    }
    return results;
  }
  if (config.action === 'listen') {
    return await new Promise(resolve => {
      const server = net.createServer();
      server.on('error', error => resolve({ error: error.code }));
      server.listen(config.port, '127.0.0.1', () => server.close(() => resolve({ listening: true })));
    });
  }
  if (config.action === 'udp') {
    return await new Promise(resolve => {
      const socket = require('node:dgram').createSocket('udp4');
      function done(result) { try { socket.close(); } catch {} resolve(result); }
      socket.on('error', error => done({ error: error.code }));
      socket.send('udp', config.port, config.host, error => done(error ? { error: error.code } : { sent: true }));
    });
  }
  throw new Error('Unknown probe action');
}

function tcp({ host, port, mode }) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let body = '';
    let error;
    if (mode === 'before-connect') socket.setKeepAlive(true, 60000);
    socket.connect({ host, port });
    if (['connecting', 'failed'].includes(mode)) socket.setKeepAlive(true, 60000);
    if (mode === 'repeated') {
      for (let i = 0; i < 20; i++) socket.setKeepAlive(true, 60000);
      socket.setKeepAlive(false);
    }
    socket.once('connect', () => {
      if (mode === 'connected') socket.setKeepAlive(true, 60000);
      socket.write('guest-tcp');
    });
    socket.on('data', chunk => {
      body += chunk.toString();
      if (body === 'guest-tcp') socket.destroy();
    });
    socket.on('error', reason => { error = reason.code ?? reason.message; });
    socket.setTimeout(4000, () => { error = 'timeout'; socket.destroy(); });
    socket.once('close', () => resolve({
      mode, body, error, connectListeners: socket.listenerCount('connect'),
    }));
  });
}

main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.log(JSON.stringify({ error: error.code ?? error.message, cause: error.cause?.message }));
});
