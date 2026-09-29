# Native HTTPS and secret substitution

```sh
npm run build
node examples/11-api-authorization/main.js
```

This example calls only `Sandbox.create()`, `exec()`, and `close()`. The proxy starts automatically during creation and is cleaned up when the sandbox closes.

The host configures `network.secrets.API_KEY` with this example's test token. The guest sees only a `sandbox-...` environment variable that is 128 characters long. It places that placeholder in Authorization, and the TLS MITM proxy substitutes the real value within the allowed domain and port. The upstream returns only `authorized: true`, without echoing the token.

The end of `main.js` contains this example's own HTTPS fixture. `network.dns` and `caCerts` route the test domain to the local service and validate its certificate; public HTTPS requests generally need neither option. The library manages the guest's `fetch()`, Node CA trust, and EdgeJS keepalive compatibility, with no application-side network patch or RPC adapter.

Optional public HTTPS check:

```sh
npm run test:proxy:online
PROXY_SMOKE_URL=https://example.com/ npm run test:proxy:online
```

The public HTTPS script uses only a non-sensitive demo header. The target service determines the actual HTTP status and response content.
