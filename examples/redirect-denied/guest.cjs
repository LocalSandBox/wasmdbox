'use strict';

const assert = require('node:assert/strict');

async function main() {
  await assert.rejects(fetch(process.env.API_URL, {
    headers: { authorization: `Bearer ${process.env.API_KEY}` },
  }));
  console.log('Redirect to a disallowed target failed.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
