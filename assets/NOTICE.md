# Bundled runtime resources

Wasmdbox redistributes the original WASM atoms and resource files from the
packages below inside one self-contained WEBC. It is stored as ordered binary
chunks in `runtime/`; no atom is recompiled or modified. Source package versions,
original download URLs, SHA-256 digests, dependency constraints and manifests,
plus the assembled runtime and chunk hashes, are recorded in `runtime-lock.json`.
The original source WEBCs are maintainer inputs and are not included in npm.

License texts accompany the SDK and are also available to guests under
`/opt/wasmdbox/licenses`. Original resource directories retain their own notices.

| Resource | Package version | Upstream | License text |
| --- | --- | --- | --- |
| EdgeJS/QuickJS | 0.2.5 | https://github.com/wasmerio/edgejs | `licenses/wasmer-edgejs-quickjs.txt` |
| Python | 3.13.20 | https://github.com/python/cpython/tree/v3.13.15 | `licenses/python-python.txt` |
| Bash | 1.0.25 | https://github.com/wasix-org/bash | `licenses/wasmer-bash.txt` |
| Coreutils | 1.0.27 | https://github.com/wasix-org/coreutils | `licenses/wasmer-coreutils.txt` |

Registry package versions are not necessarily the upstream program versions:
the Python package's manifest contains CPython 3.13.15. Bash's registry metadata
labels its license `GNU`; its upstream COPYING is GNU GPL version 3. Coreutils
is the MIT-licensed Rust implementation. The SDK's own MIT license does not
replace the licenses of these resources or their bundled third-party components.

Maintainers update the reviewed lock file and license notices together, then run
`npm run runtime:update`, `npm run runtime:bundle`, and the offline tests.
Ordinary builds never contact the registry or invoke a package builder.
