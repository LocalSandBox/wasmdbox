# wasmdbox

Create WASM sandboxes in Node.js and run Node, Python, Bash, and coreutils commands. Written in TypeScript, with ESM exports and type declarations. Requires **Node.js 24+** on the host. No Wasmer CLI or Docker required.

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

`Sandbox.create()` verifies and loads the bundled packages, initializes Wasmer, and creates the sandbox. When networking is enabled, it also manages the proxy's startup and shutdown.
The default packages are EdgeJS `0.2.5` and Python `3.13.20`, with pinned Bash/Coreutils dependencies. Node compatibility comes from EdgeJS/QuickJS; it is not a full host Node.js runtime.

## Running from the repository

```sh
nvm use
npm ci
npm run build
npm run runtime:verify               # Verify checked-in runtime resources without network access
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

A self-contained runtime WEBC ships inside the npm package. Creation loads it with the official Wasmer engine and never queries a registry or downloads package content. No preparation, postinstall or runtime cache is needed. The `cacheDir` option has been removed; delete it from creation options. Guest networking is controlled separately. See the [bundled-runtime and migration guide](docs/bundled-runtime.md).

The [package-install example](docs/install-validation.md) installs `is-number@7.0.0` into `.artifacts/package-install/` through a writable mount. It closes the installer, then verifies the saved package from a new sandbox with a read-only mount and guest networking disabled. The host installation remains after both sandboxes close.

The build produces JavaScript, declaration files, and a private copy of the Wasmer SDK inside the package. `test:package` uses the current build without rebuilding: it installs into a temporary directory with `--ignore-scripts`, makes the SDK directory read-only, and verifies commands, mounts, and HTTPS secret substitution. Consumer installation requires no postinstall script and does not modify a shared `@wasmer/sdk` dependency. The verified tarball is saved under `.artifacts/npm/`.

GitHub Actions runs validation on Linux, macOS and Windows on pull requests and pushes to `main`, including commands, virtual files, local host directory mounts, package loading and networking. Windows mounts use the Node filesystem adapter without native addons; see the [mount guide](docs/sdk-host-mounts.md) for path restrictions and filesystem boundaries. Pushing a matching `v*` version tag runs validation and publishes the same verified tarball to public npm using trusted publishing and to `npm.sea.com` using GitHub Secrets. See the [publishing guide](docs/publishing.md) for the one-time account setup and release commands.

Default Node, Python, Bash and Coreutils commands work without package selection. The bundled runtime contains one provider for each command, using the Bash/Coreutils versions required by EdgeJS. If an extra local package exports the same command as a default or another extra package, an unqualified call throws `COMMAND_AMBIGUOUS`. Explicitly select a default command with:

```js
await sandbox.exec(['bash', '-c', 'python --version'], { package: 'default', check: true });
await sandbox.exec(['python', '--version'], { package: 'default', check: true });
```

This selects the initial command only; installed packages remain available to child processes. Other `package` values are rejected, and a command absent from the default packages returns `COMMAND_NOT_FOUND`.

The bundled WASIX Bash has a known parsing limitation with multiline JavaScript inside quoted `node -e` arguments: it can return success without executing that script. Use a guest script file such as `/tmp/script.cjs` and `node /tmp/script.cjs`, or call `exec(['node', '-e', source])` directly.

Host mounts also have documented [platform boundaries and regression gates](docs/sdk-host-mounts.md#platform-regression-gates-and-known-limitations): a command can temporarily list both case aliases for one host file, and guest `fs.chmodSync()` success does not guarantee a host permission change. The platform tests verify host data and subsequent sandbox commands, including native Windows path and file-sharing cases.

## Creation options

```ts
const sandbox = await Sandbox.create({
  files: { '/workspace/input.txt': 'hello' },
  env: { MODE: 'demo' },
  mounts: [{ hostPath: './data', guestPath: '/mounted', readOnly: false }],
  network: false,
  startupTimeoutMs: 180_000,
  signal: abortController.signal,
});
```

- `files` imports strings or `Uint8Array` values at creation time for guest scripts and initial data.
- `env` explicitly passes environment variables to the guest. Host environment variables are not forwarded automatically.
- `extraPkgs` accepts only `readonly Uint8Array[]`: nonempty self-contained WEBC v3 or raw WASI bytes, including Node Buffers. All strings (including built-in package names, URLs and paths) are rejected with `INVALID_OPTIONS` before worker startup. Node and Python are always present.
- `mounts` mounts existing host directories. Relative `hostPath` values resolve against the host's current working directory. Guest changes to writable mounts go directly to disk; read-only mounts reject changes. See the [mount guide](docs/sdk-host-mounts.md).
- Omitting `network` or setting it to `false` disables guest networking. `network: {}` enables a managed TCP proxy.
- `startupTimeoutMs` defaults to 180 seconds. `signal` controls creation only; commands have separate timeout and cancellation options.

**This release does not expose `sandbox.fs`.** Use guest Node `fs` or a shell for file operations. Mount an existing host directory at exact `/workspace` to make the default working directory read-write and persistent:

```js
const sandbox = await Sandbox.create({
  mounts: [{ hostPath: './project', guestPath: '/workspace', readOnly: false }],
});
try {
  await sandbox.exec(['bash', '-c', 'printf hello > report.txt'], { check: true });
} finally { await sandbox.close(); }
// ./project/report.txt remains on the host.
```

With a `/workspace` mount, `files` writes into that host directory during creation, overwrites matching files, and obeys `readOnly` and `denyWritePaths`. **Creation is not transactional:** errors, timeouts and cancellation may leave partial writes or created directories. No rollback or automatic retry is provided. Without this mount, `/workspace` and `files` use temporary in-memory storage. Closing a sandbox never deletes mounted user files. Commands can use a host mount or its subdirectory as `cwd`.

Managed CA files live in a separate, private, read-only `/.wasmdbox` mount, never in the project. Its parent-owned temporary directory is removed after runtime termination on close or SDK-managed failure/cancellation. Killing the entire owner process can leave temporary files; there is no background sweeper. Public mounts cannot use `/.wasmdbox` or its descendants. Prefer `network.caCerts` for additional CA trust.

## Loading a local WEBC package

Read a local WEBC package on the host and pass its bytes to `extraPkgs`. It does not need to be published to a registry:

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

`create()` snapshots each byte view before returning control to the caller, without detaching the caller's buffer. Only the view's visible bytes are loaded. Empty byte arrays are invalid options; malformed package contents fail during loading. Read local paths with `readFile()` first.

Each extra package must be self-contained. Bundle its dependencies into the same WEBC before passing its bytes; supplying dependencies as separate `extraPkgs` entries is not supported. Before calling Wasmer, the SDK reads the WEBC v3 indexed manifest and rejects external dependencies with `CREATE_FAILED`, without fetching anything. Raw WASI modules are also accepted. Unsupported container versions and malformed metadata fail locally. Identical byte packages are deduplicated, including bytes matching the bundled runtime.

Python is available directly:

```js
const sandbox = await Sandbox.create();
try {
  console.log((await sandbox.exec(['python', '--version'], { check: true })).stdout);
} finally {
  await sandbox.close();
}
```

The [Python example](examples/extra-packages/main.js) imports a Python guest file and runs it with the default packages.

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

Real WASM regression tests cover 1 MiB and 2 MiB UTF-8 `bash -c` heredocs, verifying persisted byte counts, SHA-256 and subsequent command reuse. These are tested sizes, not a guarantee of unlimited arguments or a replacement for a consumer application's smaller command/request limits.

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
| Creation failure / worker crash / proxy failure / call after closing | `SandboxError` |
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
- `network.ports` is an optional destination-port allowlist, intersected with the host policy. Omit it to permit any port, or use `[]` to deny every port. Values must be integers from 1 to 65535. For a private broker, combine its allowed host with `ports: [brokerPort]`. The public `NETWORK_PORT_POLICY_VERSION` export is `1` for this contract.
- `secrets[name].hosts` supports exact and wildcard domains. `ports` defaults to `[443]`. Secret scope only limits credential use; it does not expand the network allow rules.
- Connections without a matching secret rule pass through unchanged. An unavailable proxy never triggers a fallback to a direct connection.
- MITM checks that the SOCKS target, SNI, and Host agree. It does not substitute routing, framing, or other protocol control fields.
- Bodies are processed as byte streams, including placeholders split across chunks. Compressed bodies pass through unchanged. Placeholders transformed with Base64, hashing, or similar operations are not recognized.
- Responses are not rewritten, and real credentials echoed by an upstream are not automatically redacted. Only grant secrets to trusted upstreams.
- The proxy currently supports TCP, and MITM supports HTTP/1.1. UDP/QUIC, HTTP/2 MITM, mTLS, and certificate pinning are not supported.

For local services or a private CA, configure `network.dns` (domains mapped to IP arrays) and `network.caCerts` (additional trusted PEM certificates). Public services using system DNS and standard certificates do not need these options. Each networking [example](examples/README.md) has its own server and certificates.

## Examples and implementation notes

The [standalone example index](examples/README.md) covers file isolation, disabled networking, secret substitution, mounts, error classification, and streaming commands. Each example demonstrates complete public SDK usage, keeps guest code in a separate file, and has its own fixtures.

The project pins `@wasmer/sdk@0.19.1`. The build adds the required mount, proxy, and failure-observation support only to the private SDK copy inside the package. EdgeJS 0.2.5 uses its native keepalive implementation; wasmdbox no longer injects a keepalive preload into `NODE_OPTIONS`. Dependency upgrades require another round of regression tests without patches and ablation checks.

## License

wasmdbox's own code is [MIT licensed](LICENSE). The bundled Wasmer SDK retains its own Modified MIT License at `dist/vendor/wasmer-sdk/LICENSE` in the published package. Bundled runtime components retain their respective licenses; see `dist/assets/NOTICE.md` and `dist/assets/licenses/` in the published package.
