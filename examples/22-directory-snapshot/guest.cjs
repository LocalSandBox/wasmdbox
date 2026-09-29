'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

assert.equal(fs.readFileSync('/workspace/data/hello.txt', 'utf8'), 'hello from host\n');
const config = JSON.parse(fs.readFileSync('/workspace/data/nested/config.json', 'utf8'));
assert.equal(config.message, 'nested file is visible');
fs.writeFileSync('/workspace/data/hello.txt', 'changed by WASM\n');
fs.writeFileSync('/workspace/data/result.txt', 'written by WASM\n');
assert.equal(fs.readFileSync('/workspace/data/hello.txt', 'utf8'), 'changed by WASM\n');
assert.equal(fs.readFileSync('/workspace/data/result.txt', 'utf8'), 'written by WASM\n');
console.log('Read and modified the imported directory snapshot.');
