# Protected compute integration boundary

Runtime wiring is performed by the local-api composition root only. The default runtime stays
unavailable until deployment injects all of the following environment-only public configuration:

- an HTTPS `baseUrl` and compute public keys verified by
  `verifySignedPublicProtectedComputeConfig` (or the all-in-one
  `createProtectedComputeClientFromSignedConfig`);
- pinned Ed25519 public keys through `createStaticProtectedComputeTrustStore`;
- a short-lived license token provider (never a bundled long-lived token);
- current revocation state;
- an approved persistent signed-result store if offline reuse is enabled.

The local routes are `/api/protected-compute/status`, `/contracts`, and `/execute`. Electron main
adds the current short-lived login token to the authenticated loopback request; Renderer cannot set
or read that header. `server.js` loads only a signed-public config plus a fingerprint-pinned Ed25519
configuration key. Missing, expired, tampered, revoked, or incomplete configuration disables the
execute route without disabling unrelated local modules. The default composition root keeps offline
reuse off because it does not install a persistent signed-result store.

Call path: Renderer typed client -> local-api domain service -> `ProtectedComputeClient` ->
license-center `/api/protected-compute/execute`. Renderer code must never call the remote endpoint
directly. The client accepts only public input-contract fields and rejects Ozon keys, passwords,
cookies, authorization headers, private keys, and token-shaped secret fields before transport.

The result is usable only after Ed25519 verification plus capability/version/input hash, request
nonce, time-window, revocation and replay checks. Offline fallback accepts only the same signed
envelope, within its explicit policy and use limit. This boundary does not perform any Ozon write;
the existing preview -> confirm -> submit -> Ozon readback flow remains mandatory downstream.
