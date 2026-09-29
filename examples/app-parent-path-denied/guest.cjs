'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.throws(() => fs.readFileSync('/workspace/app/../hidden.txt'), { code: 'ENOENT' });
