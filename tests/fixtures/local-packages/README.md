# Local package admission fixtures

Regular tests use the checked-in WEBC files. To rebuild them, install a Rust
toolchain with `wasm32-wasip1`, then run:

```sh
node tests/fixtures/local-packages/build.mjs
```

`RUSTC` and `CARGO` can select alternate executables. The writer's Cargo.lock
pins its build dependencies; rebuilding fixtures may fetch those build tools.
SDK builds and consumers do not run this script.

Each fixture uses the repository's `examples/local-package/hello.rs`. A small
WEBC writer preserves the `package.wapm.name` and `version` annotations that
`wasmer package build` removes. `local-parent` requires `local-dependency` at
exactly 1.0.0. It must now be rejected before Wasmer loading, whether or not
`local-dependency` or `wrong-version` (2.0.0) is supplied alongside it.
`bash-shadow` and `builtin-override` export conflicting Bash commands; the latter
uses the old built-in identity to verify that identities cannot replace the
new anonymous self-contained runtime. Both require explicit default selection.
