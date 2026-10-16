# Bundled runtime and migration

Wasmdbox ships EdgeJS 0.2.5, Python 3.13.20, Bash 1.0.25 and Coreutils
1.0.27 inside one self-contained WEBC. `Sandbox.create()` verifies and reads it
locally, then calls the official Wasmer SDK's `packages.load(bytes)` and creates
the sandbox. No registry, postinstall, prepared cache or download permission is
required. WASM engine initialization and command compilation still take time.

## Breaking changes

- Remove `Sandbox.prepare()` calls, `PrepareOptions` imports and startup gates
  used only to download runtime packages. The method has been removed. Call
  `Sandbox.create()` directly.
- Remove Python references from `extraPkgs`. Node, Python, Bash and Coreutils
  are always enabled.
- `extraPkgs` accepts only `readonly Uint8Array[]`, including Node Buffers.
  Strings, URLs and paths are rejected with `INVALID_OPTIONS` before worker
  startup. Read files on the host and pass their bytes.
- Extra packages must be self-contained WEBC v3 or raw WASI modules. Packages
  with external dependencies fail with `CREATE_FAILED`, even when matching
  dependencies are supplied in another `extraPkgs` entry or happen to be built
  in. Repackage the dependency closure into one WEBC using the official Wasmer
  CLI before supplying it. Older WEBC formats must be rebuilt as v3.
- `package: 'default'` selects the bundled command set, including Python. Bash
  and Coreutils have one built-in provider. Extra command conflicts retain
  `COMMAND_AMBIGUOUS`; identical byte packages are deduplicated.
- Initialization failures use `CREATE_FAILED`. Startup cancellation, deadlines
  and worker cleanup still apply. Remove `cacheDir` from creation options; it is
  no longer part of the API and passing it returns `INVALID_OPTIONS`. Old
  downloaded caches are ignored and are not deleted by the SDK.

Guest networking is independent. Programs using network access or guest
npm/pip installation still configure `network` as before.

## Distribution and build

The official npm `@wasmer/sdk@0.19.1` supplies the engine WASM and matching
bindings. Wasmdbox retains its existing JS integrations for host mounts, network
proxying and lifecycle handling. There is no local dependency resolver patch,
replacement engine, or `engine:rebuild` step.

`assets/runtime-lock.json` records source versions, URLs, hashes, sizes,
original manifests, dependency constraints, licenses and the pinned package
builder. It also records the assembled WEBC and each chunk's size and SHA-256.
The runtime contains four original WASM atoms, complete resource files, and all
94 original command definitions, including per-command environment variables
and arguments (`pip`, `npm`, `pnpm`, and `[` included).

The roughly 154 MiB WEBC is stored in ordered chunks of at most 48 MiB to stay
below GitHub's per-file limit. These are ordinary Git files. Runtime loading
reads chunks directly into one preallocated buffer, incrementally checking
both chunk and whole-container hashes without a concatenation copy;
it never writes to the installed SDK directory. Licenses are included both
beside the chunks and inside the package at `/opt/wasmdbox/licenses`.

`npm run build` and `npm pack` only verify/copy these committed resources. The
build verifies them once before replacing its output and reuses that manifest
when copying, without a second full verification.
They need neither the Wasmer CLI nor Rust, and do not download runtime assets.

## Updating resources

This is an explicit maintainer operation:

1. Update source versions, URLs, sizes, hashes, dependency constraints, original
   binary manifests and license notices in `assets/runtime-lock.json` and
   `assets/licenses`. Review the entire fixed dependency closure.
2. Run `npm run runtime:update`. It obtains missing source WEBCs from the locked
   URLs into ignored `.artifacts/runtime-sources` and checks their hashes.
3. Install the Wasmer CLI version recorded in `bundleTool` (currently 7.4.2).
   Run `npm run runtime:bundle`; `WASMER` may select the CLI executable.
4. Review the generated chunks and lock changes. The recipe checks dependency
   constraints, refuses duplicate commands/atoms/mounts, preserves original
   command annotations, and compares all resource contents after repacking.
   The CLI detects WASM features itself; differences are recorded in
   `runtime.featureChanges` (currently Bash gains a `multi-memory` annotation,
   with unchanged WASM bytes). Resource timestamps are normalized before build.
5. Run `npm test`, `npm run typecheck`, `npm run demo`, `npm run test:package`
   and patch ablations. Complete Linux, macOS and Windows CI before releasing.

This recipe is specific to the reviewed built-in resources. It does not provide
a general dependency resolver to applications. Missing source files stop the
bundle operation; it does not download them implicitly.

## Extra package admission

Before any upstream loading, Wasmdbox reads the WEBC v3 index and the manifest
at its declared location. It rejects nonempty `use` declarations, external atom
or filesystem references, ambiguous CBOR maps, invalid lengths/offsets and
unsupported formats. Metadata is bounded to 4 MiB per section and 32 nested
levels. This check prevents package acquisition; it does not replace Wasmer's
binary validation. The guest network policy remains a separate control.

A Wasmdbox-owned worker preload runs after inherited application module hooks
and disables host `fetch` in the supervisor and inherited engine workers. This
also blocks the stock engine's HTTP fallback
when a guest executes a dependency-bearing WEBC from its filesystem. The
application's main realm is unchanged. Guest TCP/HTTP still uses the managed
network bridge and proxy; no Wasmer SDK source change is needed for this policy.

## Verification

Package tests block and record host fetch attempts and cover empty/stale
caches, repeated creation, deduplication, command conflicts, dependency-bearing
extras, corrupt/missing/reordered chunks, cancellation, timeout and cleanup.
The npm verifier installs outside the repository with lifecycle scripts
disabled, makes the SDK directory read-only, and exercises Node/Python/Bash,
local packages, host mounts and native HTTPS proxying. CI covers all three
supported operating systems.

The migration PoC also found two pre-existing cases where Node/Python capture
no stdout from a direct pnpm child process. They reproduce with the previous
local-resolver engine and are not fixed by this packaging migration. Direct
pnpm calls and Bash-to-pnpm calls work; invoking the pnpm script through Node
also requires a suitable `HOME` environment variable.
