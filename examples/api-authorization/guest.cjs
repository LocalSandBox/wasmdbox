'use strict';

const assert = require('node:assert/strict');

async function main() {
  assert.match(process.env.API_KEY, /^sandbox-[a-f0-9]{120}$/);
  const response = await fetch(process.env.API_URL, {
    headers: { authorization: `Bearer ${process.env.API_KEY}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authorized: true });
  console.log('Guest sees a placeholder; upstream receives the real credential.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
