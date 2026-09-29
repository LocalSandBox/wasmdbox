'use strict';

// TODO(edgejs-keepalive): remove this file and --require after a fixed EdgeJS
// release replaces wasmer/edgejs-quickjs@=0.1.4 AND the unpatched fetch/keepalive
// regression passes. Upstream: src/edge_tcp_wrap.cc, TcpSetKeepAlive WASIX path
// (SO_KEEPALIVE without TCP_KEEP* timing options).
// Undici sets keepalive while connecting; 0.1.4 then fails with ENOSYS. Deferring
// avoids libuv's deferred timing options. Keepalive timing is not guaranteed.
// Compatibility only: security policy stays in the host TCP bridge.
const { Socket } = require('node:net');
const original = Socket.prototype.setKeepAlive;
const pending = new WeakMap();

Socket.prototype.setKeepAlive = function setKeepAlive(enabled, delay) {
  if (!this.pending || this.destroyed) return original.call(this, enabled, delay);
  let state = pending.get(this);
  if (state) {
    state.enabled = enabled;
    state.delay = delay;
    return this;
  }
  state = { enabled, delay };
  pending.set(this, state);
  const clear = () => {
    this.off('connect', apply);
    this.off('close', clear);
    pending.delete(this);
  };
  const apply = () => { clear(); original.call(this, state.enabled, state.delay); };
  this.once('connect', apply);
  this.once('close', clear);
  return this;
};
