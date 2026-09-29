'use strict';

const assert = require('node:assert/strict');

async function main() {
  const https = require('node:https');
  const status = await new Promise((resolve, reject) => {
    const request = https.request(process.env.API_URL, {
      servername: new URL(process.env.API_URL).hostname,
      headers: { host: 'blocked.demo.test', authorization: `Bearer ${process.env.API_KEY}` },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.ok(status >= 400 && status < 500, `Expected policy rejection, got ${status}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
