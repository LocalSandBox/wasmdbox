'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

assert.equal(fs.readFileSync('/mounted/hello.txt', 'utf8'), 'original host content\n');
fs.writeFileSync('/mounted/hello.txt', 'written by WASM\n');
fs.mkdirSync('/mounted/nested', { recursive: true });
fs.writeFileSync('/mounted/nested/to-rename.txt', 'new host file\n');
fs.renameSync('/mounted/nested/to-rename.txt', '/mounted/nested/renamed.txt');

fs.writeFileSync('/mounted/positioned.txt', '0123456789ABCDEF');
const fd = fs.openSync('/mounted/positioned.txt', 'r+');
try {
  fs.writeSync(fd, Buffer.from('XYZ'), 0, 3, 4);
  fs.ftruncateSync(fd, 10);
} finally {
  fs.closeSync(fd);
}

fs.writeFileSync('/mounted/deleted.txt', 'remove me');
fs.unlinkSync('/mounted/deleted.txt');
fs.mkdirSync('/mounted/empty');
fs.rmdirSync('/mounted/empty');

// Reading and writing a large file preserves its binary contents.
const bytes = Buffer.alloc(768 * 1024);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
fs.writeFileSync('/mounted/binary.bin', bytes);
assert.deepEqual(fs.readFileSync('/mounted/binary.bin'), bytes);
