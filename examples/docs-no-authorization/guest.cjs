'use strict';

const assert = require('node:assert/strict');

async function main() {
  const response = await fetch(process.env.API_URL, {
    headers: { 'x-api-key': process.env.API_KEY },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hasAuthorization: false, placeholder: true });
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
