'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

fs.writeFileSync('/workspace/work/result.txt', 'written by WASM\n');
assert.equal(fs.readFileSync('/workspace/work/result.txt', 'utf8'), 'written by WASM\n');
console.log('Virtual result:', fs.readFileSync('/workspace/work/result.txt', 'utf8').trim());
// Files in /workspace are not saved to the host automatically. Use a writable mount to retain them.
