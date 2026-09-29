# Installing a JavaScript package inside WASM

```sh
npm run build
npm run demo:install
```

The host entry point is [examples/package-install/main.js](../examples/package-install/main.js), with the guest files in the same directory.

1. The host downloads the `is-number@7.0.0` archive from a fixed npm URL, rejects redirects, limits its size, and verifies a pinned SHA512. It also revalidates archives found in the project's `.artifacts/` cache.
2. `Sandbox.create({ files })` imports the archive, initial package.json, and validation script. Guest networking is disabled by default.
3. The first guest process confirms that node_modules does not exist, then runs `pnpm add ./vendor/is-number-7.0.0.tgz --offline --ignore-scripts` through `sandbox.exec()`.
4. Another guest process reads the installed manifest, calls `require('is-number')`, and validates its behavior. The host checks the output.
5. `sandbox.close()` releases resources. The virtual installation is not automatically saved to the host.

This example uses a controlled host download followed by an offline guest installation. The host does not install node_modules on the guest's behalf or read virtual directories through the filesystem SDK. It currently validates one dependency-free, pure JavaScript package. Transitive dependencies require a complete set of offline packages to be prepared separately; native addons and lifecycle scripts are outside this example's scope.

The default runtime provides pnpm, with `npm` as an alias; the example does not require the Wasmer CLI. The first run needs npm registry access, so this example is excluded from the default batch run of the numbered examples.
