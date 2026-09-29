'use strict';

const assert = require('node:assert/strict');

async function main() {
  await assert.rejects(fetch(process.env.API_URL));
  console.log('Disallowed domain request failed.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
