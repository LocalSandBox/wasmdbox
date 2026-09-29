'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

assert.equal(fs.readFileSync('/mounted/hello.txt', 'utf8'), 'updated after sandbox creation\n');
const config = JSON.parse(fs.readFileSync('/mounted/nested/config.json', 'utf8'));
assert.equal(config.message, 'nested host file is visible');
assert.deepEqual(fs.readdirSync('/mounted').sort(), ['hello.txt', 'nested']);
assert.ok(fs.statSync('/mounted/nested').isDirectory());
assert.throws(() => fs.writeFileSync('/mounted/hello.txt', 'must not overwrite host\n'));
assert.throws(() => fs.writeFileSync('/mounted/blocked.txt', 'must not create host file\n'));
