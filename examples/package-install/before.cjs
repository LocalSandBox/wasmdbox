'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(fs.existsSync('/workspace/node_modules'), false);
