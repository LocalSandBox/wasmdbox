'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.throws(() => fs.readFileSync(process.argv[2], 'utf8'), { code: 'ENOENT' });
