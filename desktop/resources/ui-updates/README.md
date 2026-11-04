# Signed UI update public resource

Updates are disabled unless the sealed distribution explicitly enables them.
An enabled candidate must contain only its pinned Ed25519 `public.pem` here;
the private signing key stays outside the client staging tree and installer.
No placeholder or test key is supplied to production by default.
