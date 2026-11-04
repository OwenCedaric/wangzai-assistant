import { createHash, createPublicKey, verify } from 'node:crypto';

export const UI_UPDATE_CONTRACT = 'wangzai-ui-update/v1';
export const UI_UPDATE_MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXTENSIONS = /\.(?:html|js|mjs|css|json|svg|png|jpe?g|webp|ico|woff2?|ttf)$/u;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const uiUpdateHash = bytes => createHash('sha256').update(bytes).digest('hex');

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== keys.slice().sort().join('|')) fail('UI_UPDATE_SHAPE_INVALID');
}

export function validateUiAssetPath(value) {
  if (typeof value !== 'string' || value.length > 180 || !/^[A-Za-z0-9_./-]+$/u.test(value)
    || (value !== 'index.html' && value !== 'favicon.png' && !value.startsWith('assets/')) || !ALLOWED_EXTENSIONS.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.') || RESERVED_WINDOWS_NAME.test(part))) {
    fail('UI_UPDATE_ASSET_PATH_INVALID');
  }
  return value;
}

export function uiUpdateSigningBytes(manifest) {
  // Fixed ordered wire schema: signature never depends on input object order.
  const { contract, appId, channel, sequence, shellApi, createdAt, expiresAt, files } = manifest;
  return Buffer.from(`${UI_UPDATE_CONTRACT}\n${JSON.stringify({
    contract, appId, channel, sequence, shellApi, createdAt, expiresAt,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  })}`, 'utf8');
}

export function verifyUiManifest(envelope, { publicKey, appId, channel, shellApi = 1, now = Date.now(), requireFresh = true } = {}) {
  exactKeys(envelope, ['manifest', 'signature']);
  const { manifest, signature } = envelope;
  exactKeys(manifest, ['contract', 'appId', 'channel', 'sequence', 'shellApi', 'createdAt', 'expiresAt', 'files']);
  if (manifest.contract !== UI_UPDATE_CONTRACT || manifest.appId !== appId || manifest.channel !== channel
    || !appId || !channel) fail('UI_UPDATE_SCOPE_MISMATCH');
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1) fail('UI_UPDATE_SEQUENCE_INVALID');
  if (manifest.shellApi !== shellApi) fail('UI_UPDATE_SHELL_INCOMPATIBLE');
  const createdAt = Date.parse(manifest.createdAt), expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt
    || createdAt > now + 60_000 || (requireFresh && expiresAt <= now)) fail('UI_UPDATE_EXPIRED_OR_CLOCK_INVALID');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 2000) fail('UI_UPDATE_FILE_COUNT_INVALID');
  const names = new Set();
  let totalBytes = 0;
  for (const file of manifest.files) {
    exactKeys(file, ['path', 'bytes', 'sha256']);
    const name = validateUiAssetPath(file.path).toLowerCase();
    if (names.has(name)) fail('UI_UPDATE_DUPLICATE_PATH');
    names.add(name);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 20 * 1024 * 1024
      || !/^[a-f0-9]{64}$/u.test(file.sha256)) fail('UI_UPDATE_FILE_METADATA_INVALID');
    totalBytes += file.bytes;
  }
  if (!names.has('index.html') || totalBytes > UI_UPDATE_MAX_BYTES) fail('UI_UPDATE_CONTENT_LIMIT');
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) fail('UI_UPDATE_PATH_COLLISION');
  }
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) fail('UI_UPDATE_SIGNATURE_INVALID');
  let key;
  try { key = createPublicKey(publicKey); } catch { fail('UI_UPDATE_KEY_INVALID'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('UI_UPDATE_KEY_INVALID');
  if (!verify(null, uiUpdateSigningBytes(manifest), key, Buffer.from(signature, 'base64'))) fail('UI_UPDATE_SIGNATURE_INVALID');
  return { manifest, totalBytes, id: `${manifest.sequence}-${uiUpdateHash(uiUpdateSigningBytes(manifest)).slice(0, 24)}` };
}

export function verifyUiBundle(bundle, options) {
  exactKeys(bundle, ['manifest', 'signature', 'contents']);
  const result = verifyUiManifest({ manifest: bundle.manifest, signature: bundle.signature }, options);
  exactKeys(bundle.contents, bundle.manifest.files.map(file => file.path));
  const assets = new Map();
  for (const file of bundle.manifest.files) {
    const encoded = bundle.contents[file.path];
    if (typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(file.bytes / 3)) fail('UI_UPDATE_ASSET_SIZE_INVALID');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length !== file.bytes || uiUpdateHash(bytes) !== file.sha256) fail('UI_UPDATE_ASSET_HASH_MISMATCH');
    assets.set(file.path, bytes);
  }
  return { ...result, assets, envelope: { manifest: bundle.manifest, signature: bundle.signature } };
}
