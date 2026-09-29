'use strict';

const assert = require('node:assert/strict');

async function main() {
  const net = require('node:net');
  const code = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 });
    socket.once('error', (error) => {
      socket.destroy();
      resolve(error.code);
    });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('raw TCP unexpectedly connected'));
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('timeout is not proof of network isolation'));
    });
  });
  assert.equal(code, 'ENOTSUP');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
