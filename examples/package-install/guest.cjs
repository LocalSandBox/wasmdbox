'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const isNumber = require('is-number');
const metadata = require('is-number/package.json');
const manifest = JSON.parse(fs.readFileSync('/workspace/package.json', 'utf8'));

assert.equal(metadata.version, '7.0.0');
assert.match(manifest.dependencies['is-number'], /^file:.*is-number-7\.0\.0\.tgz$/);
assert.equal(isNumber('42'), true);
assert.equal(isNumber('abc'), false);
assert.equal(isNumber(Infinity), false);
assert.equal(fs.existsSync('/workspace/node_modules/is-number/index.js'), true);
console.log(JSON.stringify({
  package: `${metadata.name}@${metadata.version}`,
  numericString: isNumber('42'),
  nonNumericString: isNumber('abc'),
  loadedFrom: require.resolve('is-number'),
}));
