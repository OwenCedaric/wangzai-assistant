/**
 * Maximum request body for an explicit one-time legacy-import endpoint.
 *
 * Each route must still opt in by name and the desktop proxy separately
 * enforces the same exact POST-path allowlist.  This is deliberately not a
 * general local-api transport limit.
 */
export const LEGACY_BULK_IMPORT_MAX_BODY_BYTES = 8 * 1024 * 1024;
