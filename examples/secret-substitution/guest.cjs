'use strict';

const assert = require('node:assert/strict');

async function main() {
  const key = process.env.API_KEY;
  assert.match(key, /^sandbox-[a-f0-9]{120}$/);
  const response = await fetch(`${process.env.API_URL}/${key}?key=${key}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key, nested: { key } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: true, header: true, body: true });
  console.log('The same placeholder is replaced in the URL, header and body.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
