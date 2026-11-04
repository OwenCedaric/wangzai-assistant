# Protected-compute public release resources

Only these generated public files may be staged here for a production build:

- `protected-compute.signed-public.json`
- `configuration-public.pem`

Use `C:\MANAGEMENT\backend\scripts\build_protected_compute_public_config.py`
to create a public-only bundle and `desktop/scripts/configure-distribution.mjs`
to validate and stage it. Private keys are never copied into this directory.

Production sealing and package verification reject placeholder/reserved domains,
localhost, and loopback hosts. `--allow-test-fixture-urls` is an explicit staging-only
fixture option and can never bypass the production seal or final package verifier.
