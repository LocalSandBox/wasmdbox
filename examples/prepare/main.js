import { Sandbox } from 'wasmdbox';
import { fileURLToPath } from 'node:url';

// Download the default runtime and its dependencies without starting a guest.
await Sandbox.prepare({
  cacheDir: fileURLToPath(new URL('../../.wasmer/', import.meta.url)),
});
console.log('PASS: runtime packages are cached; no sandbox was created');
