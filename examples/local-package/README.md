# Local WEBC package

Run from the repository root after `npm run build`, using Node 24+:

```sh
node examples/local-package/main.js
```

The example reads the bundled `hello.webc` as a Node Buffer, passes it to
`Sandbox.create({ extraPkgs: [webcBytes] })`, and runs the manifest's
`local-hello` command. Expected output includes `hello from local webc` and a
PASS line confirming that the default Node runtime is also available.

The package has no dependencies and is not published. Running the example needs
neither Rust nor the Wasmer CLI. The default runtime is still acquired through
the usual cache/registry path, so the first run requires network access even
though guest networking is disabled.

To rebuild the fixture, install Rust with the `wasm32-wasip1` target and the
Wasmer CLI, then run:

```sh
rustup target add wasm32-wasip1
node examples/local-package/build.mjs
```

The script compiles `hello.rs` and packages it using `wasmer.toml` in a temporary
directory, then replaces `hello.webc`. It does not publish the package. The
manifest's source path refers to the temporary compiled module.
