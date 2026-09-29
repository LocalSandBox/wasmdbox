'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

async function main() {
  assert.match(process.env.API_KEY, /^sandbox-[a-f0-9]{120}$/);
  fs.writeFileSync('/mounted/result.txt', 'written by installed package\n');
  const response = await fetch(process.env.API_URL, {
    headers: { authorization: `Bearer ${process.env.API_KEY}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authorized: true });
  console.log('installed consumer guest passed');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
