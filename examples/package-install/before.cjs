'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

assert.ok(fs.statSync('/mounted').isDirectory());
assert.equal(JSON.parse(fs.readFileSync('/mounted/package.json', 'utf8')).private, true);
assert.equal(fs.existsSync('/workspace/node_modules'), false);
console.log(JSON.stringify({
  installDirectory: '/mounted',
  alreadyInstalled: fs.existsSync('/mounted/node_modules/is-number/package.json'),
}));
