'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.readFileSync('/workspace/work/hello.txt', 'utf8'), 'visible to WASM\n');
