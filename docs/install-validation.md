# Installing and persisting a JavaScript package inside WASM

```sh
npm run build
npm run demo:install
```

The host entry point is [examples/package-install/main.js](../examples/package-install/main.js), with the guest files in the same directory. It uses host directory mounts on macOS, Linux or Windows local disks.

1. The host creates `.artifacts/package-install/` and seeds its `package.json` from this example's fixture only if it does not already exist.
2. The installer sandbox maps that directory to `/mounted` with a writable mount and enables networking with `network: { allow: ['registry.npmjs.org'] }`. Only the guest probe script is imported through `files`.
3. Guest pnpm runs `pnpm --dir=/mounted add is-number@7.0.0 --save-exact --ignore-scripts`. It downloads the package from npm and writes the project manifest, lockfile, and `node_modules` directly into the host mount. Command startup keeps `cwd: '/workspace'`; SDK 0.19.0 cannot initialize the WASI environment with this host mount as the command's `cwd`, so pnpm selects its project directory with `--dir`.
4. The installer sandbox is closed. The host reads the saved package metadata and entry file to verify they still exist.
5. A new sandbox mounts the same directory read-only with guest networking disabled. Its guest process loads `/mounted/node_modules/is-number`, verifies the version and results for numeric and nonnumeric inputs, and reports the resolved file path.
6. The verifier sandbox is closed. The example keeps the host installation for later use.

The saved directory is:

```text
.artifacts/package-install/
  package.json
  pnpm-lock.yaml
  node_modules/
    is-number/
      package.json
      index.js
```

Repeat `npm run demo:install` to reuse the same directory; the first guest probe reports `alreadyInstalled: true` on later runs. Existing project data is not cleared before installation, and neither sandbox close deletes it. To use another destination, change `hostDirectory` in `main.js`.

The verification script lives under `/workspace`, so it explicitly requires the mounted package path:

```js
const isNumber = require('/mounted/node_modules/is-number');
console.log(isNumber('42')); // true
```

pnpm uses `node-linker=hoisted` and `package-import-method=copy` so installed package files do not depend on host symlinks or hardlinks, which the mount adapter rejects. Its store lives in virtual `/tmp`; the installed files and lockfile are persisted in `/mounted`.

The default runtime provides pnpm, with `npm` as an alias; no Wasmer CLI is needed. This example installs one dependency-free, pure JavaScript package. Native addons and lifecycle scripts are outside its scope. It is excluded from the default local batch because it requires public registry access; CI runs it separately on all three platforms. The verifier's guest networking is disabled, but Wasmer runtime package resolution may still contact its registry during sandbox creation.
