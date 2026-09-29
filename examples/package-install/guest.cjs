'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
// This process runs in a fresh sandbox with no imported package or guest network.
const packagePath = '/mounted/node_modules/is-number';
const isNumber = require(packagePath);
const metadata = require(packagePath + '/package.json');
const manifest = JSON.parse(fs.readFileSync('/mounted/package.json', 'utf8'));

assert.equal(metadata.version, '7.0.0');
assert.equal(manifest.dependencies['is-number'], '7.0.0');
assert.equal(isNumber('42'), true);
assert.equal(isNumber('abc'), false);
assert.equal(isNumber(Infinity), false);
assert.equal(fs.existsSync('/workspace/node_modules'), false);
assert.equal(require.resolve(packagePath), '/mounted/node_modules/is-number/index.js');
console.log(JSON.stringify({
  package: `${metadata.name}@${metadata.version}`,
  numericString: isNumber('42'),
  nonNumericString: isNumber('abc'),
  loadedFrom: require.resolve(packagePath),
}));
