'use strict';

const assert = require('node:assert/strict');

async function main() {
  const response = await fetch(process.env.API_URL, {
    headers: { 'x-demo-route': process.env.API_ROUTE },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { routed: true });
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
