import { Sandbox } from 'wasmdbox';
import { resolve } from 'node:path';

try {
  let cacheDir = './.wasmer';
  const extraPkgs = [];
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run runtime:prepare -- [--cache-dir PATH] [EXTRA_PACKAGE ...]');
  } else {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--cache-dir') {
        const directory = args[++i];
        if (!directory || directory.startsWith('--')) throw new Error('--cache-dir requires a path');
        cacheDir = directory;
      } else {
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        extraPkgs.push(arg);
      }
    }
    await Sandbox.prepare({ cacheDir, extraPkgs });
    console.log(`Runtime packages prepared in ${resolve(cacheDir)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
