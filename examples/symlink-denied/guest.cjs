'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
fs.symlinkSync(process.argv[2], '/workspace/work/escape-link');
assert.throws(() => fs.readFileSync('/workspace/work/escape-link'), { code: 'ENOENT' });
