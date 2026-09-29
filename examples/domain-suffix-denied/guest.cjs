'use strict';

const assert = require('node:assert/strict');

async function main() {
  await assert.rejects(fetch(process.env.API_URL));
  console.log('An attacker suffix does not match the allowed domain.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
