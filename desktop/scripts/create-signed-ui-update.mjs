import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { UI_UPDATE_CONTRACT, uiUpdateHash, uiUpdateSigningBytes, validateUiAssetPath, verifyUiBundle } from '../src/updates/signedUiBundle.js';

export function createSignedUiUpdate({ inputDirectory, privateKey, appId, channel, sequence, shellApi = 1,
  createdAt = new Date().toISOString(), expiresAt } = {}) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('UI_UPDATE_PRIVATE_KEY_INVALID');
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const root = path.resolve(inputDirectory), queue = [root], files = [], contents = {};
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('UI_UPDATE_INPUT_DIRECTORY_INVALID');
  while (queue.length) {
    for (const entry of fs.readdirSync(queue.pop(), { withFileTypes: true })) {
      const file = path.join(entry.parentPath || entry.path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('UI_UPDATE_INPUT_LINK_FORBIDDEN');
      if (entry.isDirectory()) { queue.push(file); continue; }
      if (!entry.isFile()) throw new Error('UI_UPDATE_INPUT_SPECIAL_FILE');
      const relative = validateUiAssetPath(path.relative(root, file).replaceAll('\\', '/'));
      const bytes = fs.readFileSync(file);
      files.push({ path: relative, bytes: bytes.length, sha256: uiUpdateHash(bytes) });
      contents[relative] = bytes.toString('base64');
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { contract: UI_UPDATE_CONTRACT, appId, channel, sequence, shellApi, createdAt, expiresAt, files };
  const bundle = { manifest, signature: sign(null, uiUpdateSigningBytes(manifest), key).toString('base64'), contents };
  verifyUiBundle(bundle, { publicKey, appId, channel, shellApi });
  return bundle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = new Map(process.argv.slice(2).map(value => {
    const match = value.match(/^--([a-z-]+)=(.+)$/u);
    if (!match) throw new Error('UI_UPDATE_PUBLISH_ARGUMENT_INVALID');
    return [match[1], match[2]];
  }));
  const allowed = ['input', 'output', 'private-key-file', 'app-id', 'channel', 'sequence', 'expires-at'];
  if ([...args.keys()].some(key => !allowed.includes(key)) || allowed.some(key => !args.has(key))) throw new Error('UI_UPDATE_PUBLISH_ARGUMENT_REQUIRED');
  const output = path.resolve(args.get('output'));
  if (fs.existsSync(output)) throw new Error('UI_UPDATE_PUBLISH_REFUSES_OVERWRITE');
  const bundle = createSignedUiUpdate({ inputDirectory: args.get('input'),
    privateKey: fs.readFileSync(args.get('private-key-file'), 'utf8'), appId: args.get('app-id'),
    channel: args.get('channel'), sequence: Number(args.get('sequence')), expiresAt: args.get('expires-at') });
  const data = Buffer.from(JSON.stringify(bundle));
  // Do not create missing output directories or copy private signing material.
  const fd = fs.openSync(output, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  console.log(JSON.stringify({ publishedFile: output, sequence: bundle.manifest.sequence, bytes: data.length,
    sha256: uiUpdateHash(data), files: bundle.manifest.files.length, privateKeyIncluded: false }));
}
