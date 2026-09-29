'use strict';
const assert = require('node:assert/strict');

async function main() {
  const response = await fetch(process.env.API_URL, { redirect: 'error', headers: { 'x-sandbox-proxy': process.env.DEMO_HEADER } });
  assert.equal(response.ok, true);
  const body = await response.text();
  assert.ok(body.length > 0);
  console.log(JSON.stringify({ status: response.status, bytes: Buffer.byteLength(body) }));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
