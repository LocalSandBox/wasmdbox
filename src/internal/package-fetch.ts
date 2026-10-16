// Preloaded in the sandbox supervisor and inherited by Wasmer's Node workers.
// The stock engine can also load a WEBC executed from the guest filesystem;
// reject its host-side HTTP fallback even when it bypasses extraPkgs admission.
// Guest TCP/HTTP uses our network bridge and proxy, not this host fetch API.
// The application's main realm is unaffected.
globalThis.fetch = async () => {
  throw new Error('Host package downloads are disabled; use self-contained local WEBC packages');
};

export {};
