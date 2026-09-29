'use strict';

const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
console.log('guest received: ' + input.trim());
