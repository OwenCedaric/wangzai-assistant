export const PORT = Number(process.env.PURCHASE_SEARCH_BRIDGE_PORT || 3788);
export const HOST = '127.0.0.1';
export const MAX_BODY_SIZE = 1024 * 1024;
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PURCHASE_SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export const PURCHASE_PLUGIN_CAPTURE_LIMIT = 200;
export const BRIDGE_AUTH_TOKEN = String(process.env.PURCHASE_BRIDGE_AUTH_TOKEN || '');
export const LICENSE_STATE_PATH = String(process.env.PURCHASE_BRIDGE_LICENSE_STATE_PATH || '');
export const PURCHASE_EXTENSION_ORIGINS = new Set(
  String(
    process.env.PURCHASE_BRIDGE_EXTENSION_ORIGINS ||
      'chrome-extension://jkbnfmdnjfbiamkokbpijimlohjancdl',
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
