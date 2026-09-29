# wasmdbox

Create WASM sandboxes in Node.js and run Node, Bash, and coreutils commands. Written in TypeScript, with ESM exports and type declarations. Requires **Node.js 24+** on the host. No Wasmer CLI or Docker required.

```js
import { Sandbox } from 'wasmdbox';
import { readFile } from 'node:fs/promises';

const sandbox = await Sandbox.create({
  files: {
    '/workspace/guest.cjs': await readFile('./guest.cjs'),
  },
});

try {
  const result = await sandbox.exec(['node', '/workspace/guest.cjs']);
  console.log(result.exitCode, result.stdout, result.stderr);
} finally {
  await sandbox.close();
}
```

`Sandbox.create()` initializes Wasmer, loads the runtime, and creates the sandbox. When networking is enabled, it also manages the proxy's startup and shutdown.
The default runtime is `wasmer/edgejs-quickjs@=0.1.4`. Its Node compatibility comes from EdgeJS/QuickJS; it is not a full host Node.js runtime.

## Running from the repository

```sh
nvm use
npm ci
npm run build
npm run runtime:prepare              # Optional: download runtime packages before creating a sandbox
npm run demo                         # All standalone local examples
node examples/file-read/main.js    # Run one example
node examples/host-mount-read/main.js  # Read-only mounts
node examples/host-mount-write/main.js # Writable mounts
node examples/secret-substitution/main.js # Managed proxy and secret substitution
npm run demo:install                  # Online guest install into a persistent host mount
npm run test:proxy:online             # Optional public HTTPS smoke test
npm test
npm run test:package                  # After building, install the tarball outside the repo and verify JS/TS consumers
```

The runtime is downloaded from the Wasmer registry on first use, through either `prepare()` or `create()`. Later calls reuse downloaded content, but package resolution may still query the registry, so offline creation is not guaranteed. The standalone examples explicitly use the project's `.wasmer/` directory; the library defaults to the user's cache directory. The regular networking examples each run their own local HTTPS server and need no real credentials.

The [package-install example](docs/install-validation.md) installs `is-number@7.0.0` into `.artifacts/package-install/` through a writable mount. It closes the installer, then verifies the saved package from a new sandbox with a read-only mount and guest networking disabled. The host installation remains after both sandboxes close.

The build produces JavaScript, declaration files, and a private copy of the Wasmer SDK inside the package. `test:package` uses the current build without rebuilding: it installs into a temporary directory with `--ignore-scripts`, makes the SDK directory read-only, and verifies commands, mounts, and HTTPS secret substitution. Consumer installation requires no postinstall script and does not modify a shared `@wasmer/sdk` dependency. The verified tarball is saved under `.artifacts/npm/`.

GitHub Actions runs validation on Linux, macOS and Windows on pull requests and pushes to `main`, including commands, virtual files, local host directory mounts, package loading and networking. Windows mounts use the Node filesystem adapter without native addons; see the [mount guide](docs/sdk-host-mounts.md) for path restrictions and filesystem boundaries. Pushing a matching `v*` version tag runs validation and publishes the verified tarball to npm using trusted publishing. See the [publishing guide](docs/publishing.md) for the one-time account setup and release commands.

## Creation options

```ts
const sandbox = await Sandbox.create({
  files: { '/workspace/input.txt': 'hello' },
  env: { MODE: 'demo' },
  mounts: [{ hostPath: './data', guestPath: '/mounted', readOnly: false }],
  network: false,
  cacheDir: './.wasmer',
  startupTimeoutMs: 180_000,
  signal: abortController.signal,
});
```

- `files` imports strings or `Uint8Array` values at creation time for guest scripts and initial data.
- `env` explicitly passes environment variables to the guest. Host environment variables are not forwarded automatically.
- `extraPkgs` accepts `readonly (string | Uint8Array)[]`: Wasmer registry references, local package bytes (including Node Buffers), or a mixture. It never replaces the default runtime; omitting it or passing `[]` loads only the default runtime and its dependencies.
- `mounts` mounts existing host directories. Relative `hostPath` values resolve against the host's current working directory. Guest changes to writable mounts go directly to disk; read-only mounts reject changes. See the [mount guide](docs/sdk-host-mounts.md).
- Omitting `network` or setting it to `false` disables guest networking. `network: {}` enables a managed TCP proxy.
- `startupTimeoutMs` defaults to 180 seconds. `signal` controls creation only; commands have separate timeout and cancellation options.

**This release does not expose `sandbox.fs`.** Use the guest's Node `fs` or shell for file operations while it is running. Changes to the virtual `/workspace` are not automatically saved to the host; write persistent results to a writable mount. Closing the sandbox does not delete files in host mounts.

## Loading a local WEBC package

Read a bundled package on the host and pass its bytes to `extraPkgs`. It does not need to be published to a registry:

```js
import { readFile } from 'node:fs/promises';
import { Sandbox } from 'wasmdbox';

const webcBytes = await readFile(new URL('./hello.webc', import.meta.url));
const sandbox = await Sandbox.create({ extraPkgs: [webcBytes] });
try {
  console.log((await sandbox.exec(['local-hello'], { check: true })).stdout);
} finally {
  await sandbox.close();
}
```

Commands come from the package manifest. The [local-package example](examples/local-package/README.md) includes an unpublished `hello.webc`, its source, and a rebuild script. Run it after building with `node examples/local-package/main.js`; Rust and the Wasmer CLI are only needed to rebuild that fixture.

Both `create()` and `prepare()` snapshot each byte view before returning control to the caller, without detaching the caller's buffer. Only the view's visible bytes are loaded. Empty byte arrays are invalid options; malformed package contents fail during loading. Strings retain their registry-reference meaning; read local paths with `readFile()` first.

Local WEBC bytes remove the need to fetch that package itself. The default runtime and any package dependencies still use the cache/registry path, so this does not guarantee offline startup. Guest `network: false` does not disable host-side package acquisition.

## Preparing runtime packages

`Sandbox.prepare()` optionally loads the default runtime, additional packages, and their dependencies, downloading missing registry content into the cache. It accepts the same mixed `extraPkgs` list, including local bytes. It does not create a guest, mount directories, or start a proxy. It returns `Promise<void>` after releasing its client and worker.

```ts
await Sandbox.prepare({
  cacheDir: './.wasmer',
  extraPkgs: ['python/python@=3.13.20'],
  startupTimeoutMs: 180_000,
  signal: abortController.signal,
});

const sandbox = await Sandbox.create({
  cacheDir: './.wasmer',
  extraPkgs: ['python/python@=3.13.20'],
});
try {
  console.log((await sandbox.exec(['python', '--version'], { check: true })).stdout);
} finally {
  await sandbox.close();
}
```

The two calls are independent. `create()` always loads the packages from its own options, reuses matching cached content, and downloads anything missing. You can skip `prepare()`, prepare a larger set of packages, or pass different `extraPkgs` lists. A package being cached does not automatically make its commands available in a sandbox; local packages must also be supplied as bytes to each `create()` that needs them. Both APIs use the same default user cache directory; pass the same `cacheDir` to share a custom cache.

Package references support Wasmer version expressions. Pin versions for predictable cache reuse; unpinned references may resolve to newer versions. Registry metadata queries remain allowed, so preparation does not guarantee offline startup. It does not retain an initialized runtime or eliminate later WASM initialization work.

Repeated references and packages resolving to the same ID are deduplicated. Different packages may export the same command, including commands from shared dependencies. An ambiguous command throws `CommandError` with `COMMAND_AMBIGUOUS`; there is no implicit override. For example, the pinned Python package also exposes Bash, so adding it makes an unqualified `bash` command ambiguous, while `python` and `node` remain usable.

Preparation errors are `SandboxError`: invalid input uses `INVALID_OPTIONS`, package loading failures use `PREPARE_FAILED`, and timeouts or cancellation use `STARTUP_TIMEOUT` or `STARTUP_ABORTED`. Worker and cleanup failures retain their existing lifecycle codes. Successfully cached packages remain available after a failed or cancelled preparation.

To prepare packages explicitly from the repository after building:

```sh
npm run runtime:prepare
npm run runtime:prepare -- --cache-dir ./.wasmer python/python@=3.13.20
```

This command defaults to the project's `./.wasmer`; positional arguments are extra packages. It is not an npm `prepare` or `postinstall` lifecycle hook. See the [preparation example](examples/prepare/main.js) and [extra-package example](examples/extra-packages/main.js), which keeps the Python guest in a separate file.

## Running commands

```ts
const result = await sandbox.exec(['bash', '-c', 'printf hello; exit 7'], {
  cwd: '/workspace',
  env: { MODE: 'demo' },
  timeoutMs: 30_000,
  outputBytes: 512 * 1024,
  check: false,
});
// { exitCode: 7, stdout: 'hello', stderr: '',
//   stdoutTruncated: false, stderrTruncated: false }
```

Commands take an argv array without implicit shell parsing. To use shell syntax, explicitly run `bash -c`. The `stdin` option for `exec()` accepts a string or `Uint8Array`. Commands have no execution deadline unless `timeoutMs` is set.

With the default `check: false`, a nonzero guest exit or script exception returns a result for the caller to inspect. With `check: true`, a nonzero exit throws `CommandError`, whose `result` contains the execution result.

```ts
import { CommandError, SandboxError } from 'wasmdbox';

try {
  await sandbox.exec(['node', '/workspace/guest.cjs'], { check: true });
} catch (error) {
  if (error instanceof CommandError) {
    console.error(error.code, error.result?.exitCode, error.result?.stderr);
  } else if (error instanceof SandboxError) {
    console.error(error.code); // Sandbox creation, communication, or lifecycle failure
  } else {
    throw error;
  }
}
```

Both error classes extend `Error` directly; neither extends the other:

| Situation | Result |
| --- | --- |
| Nonzero guest exit / script exception | Returns a result by default; throws `CommandError` with `check: true` |
| Timeout / AbortSignal cancellation / explicit termination | `CommandError`, including available output |
| Directly executing an unknown command | `CommandError`, without a fabricated guest exit code |
| Preparation or creation failure / worker crash / proxy failure / call after closing | `SandboxError` |
| Network policy denies a request | The guest receives a network error; the sandbox remains usable |

`CommandError.result` may be absent, for example if the command has not started. Timeouts and cancellations are independent of `check`. If execution cannot stop within the cancellation grace period, the SDK terminates the entire sandbox and throws `SandboxError`.

Use `spawn()` for live input and output:

```ts
const child = await sandbox.spawn(['node', '/workspace/guest.cjs'], {
  stdin: 'pipe',
  check: true,
});
child.stdin!.end('hello\n');
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
const result = await child.wait();
```

stdout and stderr are Node Readable streams. `stdin: 'pipe'` provides a Writable stream; stdin is closed by default. `kill()` waits for cancellation and resolves when cancellation succeeds, while the corresponding `wait()` rejects with `CommandError`.

`outputBytes` defaults to 512 KiB per stream and limits both captured output and live delivery. Beyond that limit, the SDK continues draining the underlying output and sets the truncation flags. The output limit does not set an execution deadline.

`close()` supports repeated or concurrent calls. It cancels pending operations and cleans up workers, the proxy, and mount handles. Each sandbox manages its own resources. A fatal failure does not automatically recreate a sandbox whose state has been lost.

## Managed networking and secrets

```ts
const sandbox = await Sandbox.create({
  files: { '/workspace/guest.cjs': guestBytes },
  network: {
    allow: ['api.openai.com'],
    secrets: {
      API_KEY: {
        value: process.env.OPENAI_API_KEY!,
        hosts: ['api.openai.com'],
      },
    },
  },
});
```

Use the environment variable normally inside the guest:

```js
const response = await fetch('https://api.openai.com/v1/models', {
  headers: { authorization: `Bearer ${process.env.API_KEY}` },
});
```

`process.env.API_KEY` is an automatically generated placeholder: the `sandbox-` prefix followed by 120 random hexadecimal characters, for a total length of **128**. Each secret in each sandbox gets its own placeholder, which remains stable within that sandbox. It overrides any environment variable with the same name supplied at creation or command execution. The real `value` stays in the host proxy.

All guest TCP connections pass through the managed proxy. For destinations matching a secret's host and port scope, the proxy uses TLS MITM to replace placeholders in request URL paths and queries, ordinary header values, and uncompressed bodies with their real values. The default Node guest automatically trusts the proxy CA; callers do not need to preload certificates or start the proxy manually.

- `allow` and `deny` support domains, `*.example.com`, and IPv4/IPv6 CIDRs. Deny rules take precedence; when `allow` is provided, only matching destinations are permitted. With an allow list or a nonempty deny list, IP literals also require a matching IP/CIDR allow rule or `*`.
- `secrets[name].hosts` supports exact and wildcard domains. `ports` defaults to `[443]`. Secret scope only limits credential use; it does not expand the network allow rules.
- Connections without a matching secret rule pass through unchanged. An unavailable proxy never triggers a fallback to a direct connection.
- MITM checks that the SOCKS target, SNI, and Host agree. It does not substitute routing, framing, or other protocol control fields.
- Bodies are processed as byte streams, including placeholders split across chunks. Compressed bodies pass through unchanged. Placeholders transformed with Base64, hashing, or similar operations are not recognized.
- Responses are not rewritten, and real credentials echoed by an upstream are not automatically redacted. Only grant secrets to trusted upstreams.
- The proxy currently supports TCP, and MITM supports HTTP/1.1. UDP/QUIC, HTTP/2 MITM, mTLS, and certificate pinning are not supported.

For local services or a private CA, configure `network.dns` (domains mapped to IP arrays) and `network.caCerts` (additional trusted PEM certificates). Public services using system DNS and standard certificates do not need these options. Each networking [example](examples/README.md) has its own server and certificates.

## Examples and implementation notes

The [standalone example index](examples/README.md) covers file isolation, disabled networking, secret substitution, mounts, error classification, and streaming commands. Each example demonstrates complete public SDK usage, keeps guest code in a separate file, and has its own fixtures.

The project pins `@wasmer/sdk@0.19.0`. The build adds the required mount, proxy, and failure-observation support only to the private SDK copy inside the package. The EdgeJS keepalive compatibility layer includes a TODO to remove it after an upstream fix. Dependency upgrades require another round of regression tests without patches and ablation checks.

## License

wasmdbox's own code is [MIT licensed](LICENSE). The bundled Wasmer SDK retains its own Modified MIT License at `dist/vendor/wasmer-sdk/LICENSE` in the published package.
