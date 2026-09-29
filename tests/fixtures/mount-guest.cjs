'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');

switch (process.argv[2]) {
  case 'append': {
    fs.appendFileSync('/mounted/appended.txt', 'first');
    const fd = fs.openSync('/mounted/appended.txt', 'a+');
    fs.writeSync(fd, Buffer.from('-second'), 0, 7, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    assert.equal(fs.readFileSync('/mounted/appended.txt', 'utf8'), 'first-second');
    assert.throws(() => fs.writeFileSync('/mounted/appended.txt', 'bad', { flag: 'wx' }));
    const ro = fs.openSync('/mounted/appended.txt', 'r');
    assert.throws(() => fs.writeSync(ro, Buffer.from('bad')));
    fs.closeSync(ro);
    break;
  }
  case 'readonly': {
    for (const mutate of [
      () => fs.appendFileSync('/mounted/hello.txt', 'bad'),
      () => fs.truncateSync('/mounted/hello.txt', 0),
      () => fs.mkdirSync('/mounted/new-directory'),
      () => fs.unlinkSync('/mounted/hello.txt'),
      () => fs.renameSync('/mounted/hello.txt', '/mounted/renamed.txt'),
    ]) assert.throws(mutate);
    assert.equal(fs.readFileSync('/mounted/hello.txt', 'utf8'), 'host data');
    break;
  }
  case 'boundaries': {
    for (const path of [
      process.env.OUTSIDE_PATH, '/mounted/../outside/secret.txt',
      '/mounted/file-link', '/mounted/dir-link/secret.txt', '/mounted/hard-link',
    ]) {
      assert.throws(() => fs.readFileSync(path), 'read ' + path);
      assert.throws(() => fs.writeFileSync(path, 'bad'), 'write ' + path);
    }
    // A guest virtual symlink must not reveal an unmounted host file.
    fs.symlinkSync(process.env.OUTSIDE_PATH, '/mounted/new-link');
    assert.throws(() => fs.readFileSync('/mounted/new-link'));
    break;
  }
  case 'read':
    console.log(fs.readFileSync('/mounted/hello.txt', 'utf8'));
    break;
  case 'leak-exit':
    fs.openSync('/mounted/hello.txt', 'r');
    process.exit(7);
    break;
  case 'leak-live':
    fs.openSync('/mounted/hello.txt', 'r');
    console.log('fd-open');
    setInterval(() => {}, 1000);
    break;
  default:
    throw new Error('Unknown mount probe');
}
