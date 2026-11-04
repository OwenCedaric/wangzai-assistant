import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { uiUpdateHash } from './signedUiBundle.js';

export function readUiUpdatePublicKey({ licenseRoot, allowReadme = true } = {}) {
  if (!licenseRoot) return null;
  const directory = path.join(licenseRoot, 'ui-updates');
  if (!fs.existsSync(directory)) return null;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('UI_UPDATE_KEY_FILE_UNSAFE');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.name !== 'public.pem' && !(allowReadme && entry.name === 'README.md'))) throw new Error('UI_UPDATE_PUBLIC_RESOURCE_INVALID');
  }
  const file = path.join(directory, 'public.pem');
  if (!fs.existsSync(file)) return null;
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4096
    || path.resolve(fs.realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('UI_UPDATE_KEY_FILE_UNSAFE');
  const publicKey = fs.readFileSync(file, 'utf8');
  if (!publicKey.startsWith('-----BEGIN PUBLIC KEY-----') || createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw new Error('UI_UPDATE_KEY_INVALID');
  return publicKey;
}

export function loadUiUpdateConfig({ value, licenseRoot, serverUrl, allowReadme = true } = {}) {
  const publicKey = readUiUpdatePublicKey({ licenseRoot, allowReadme });
  if (value === undefined || value === null || value.enabled === false) return Object.freeze({ enabled: false });
  const fields = ['enabled', 'app_id', 'channel', 'public_key_sha256', 'shell_api'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled !== true
    || Object.keys(value).sort().join('|') !== fields.sort().join('|')
    || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.app_id || '')
    || !/^[A-Za-z0-9_-]{1,40}$/u.test(value.channel || '')
    || !/^[a-f0-9]{64}$/u.test(value.public_key_sha256 || '') || value.shell_api !== 1) {
    throw new Error('UI_UPDATE_CONFIG_INVALID');
  }
  const base = new URL(serverUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('UI_UPDATE_URL_INVALID');
  if (!publicKey || uiUpdateHash(publicKey) !== value.public_key_sha256) throw new Error('UI_UPDATE_KEY_INVALID');
  return Object.freeze({ enabled: true, appId: value.app_id, channel: value.channel,
    publicKey, shellApi: value.shell_api, baseUrl: `${base.toString().replace(/\/$/u, '')}/api/client-updates` });
}
