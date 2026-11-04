import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_BOX_PREFIX = 'secretbox:v1';
const DEFAULT_SECRET_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/local-api.development-secret.key',
);

function normalizeSecret(value) {
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

function encodeBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

function getSecretFilePath() {
  return process.env.LOCAL_API_SECRET_FILE
    ? resolve(process.env.LOCAL_API_SECRET_FILE)
    : DEFAULT_SECRET_FILE;
}

function readOrCreateLocalSecret() {
  const secretPath = getSecretFilePath();
  mkdirSync(dirname(secretPath), { recursive: true });

  if (!existsSync(secretPath)) {
    writeFileSync(secretPath, `${randomBytes(32).toString('base64url')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  }

  return readFileSync(secretPath, 'utf8').trim();
}

function getMasterSecretMaterial() {
  const envSecret = normalizeSecret(process.env.LOCAL_API_SECRET);
  return envSecret || readOrCreateLocalSecret();
}

function deriveEncryptionKey() {
  return createHash('sha256').update(getMasterSecretMaterial(), 'utf8').digest();
}

/**
 * Derives a stable, domain-separated 256-bit key from the profile master
 * secret. Internal stores use this instead of creating parallel plaintext key
 * files or depending on an optional recovery keyset row.
 */
export function deriveScopedEncryptionKey(namespace) {
  const scope = normalizeSecret(namespace);
  if (!scope) throw new Error('Scoped encryption key namespace is required.');
  return createHmac('sha256', deriveEncryptionKey())
    .update(`wangzai-scoped-key:v1\0${scope}`, 'utf8')
    .digest();
}

export function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(`${SECRET_BOX_PREFIX}:`);
}

export function encryptSecret(value) {
  const plaintext = normalizeSecret(value);
  if (!plaintext) {
    return null;
  }

  if (isEncryptedSecret(plaintext)) {
    return plaintext;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    SECRET_BOX_PREFIX,
    encodeBase64Url(iv),
    encodeBase64Url(authTag),
    encodeBase64Url(ciphertext),
  ].join(':');
}

export function decryptSecret(value) {
  const envelope = normalizeSecret(value);
  if (!envelope) {
    return null;
  }

  if (!isEncryptedSecret(envelope)) {
    return null;
  }

  const parts = envelope.split(':');
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== SECRET_BOX_PREFIX) {
    throw new Error('Invalid encrypted shop secret envelope.');
  }

  const [, , ivPart, tagPart, ciphertextPart] = parts;
  const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey(), decodeBase64Url(ivPart));
  decipher.setAuthTag(decodeBase64Url(tagPart));

  return Buffer.concat([
    decipher.update(decodeBase64Url(ciphertextPart)),
    decipher.final(),
  ]).toString('utf8');
}

export function createIrreversibleSecretReference(namespace, value) {
  const scope = normalizeSecret(namespace);
  const material = normalizeSecret(value);
  if (!scope || !material) throw new Error('Secret reference namespace and value are required.');
  return createHmac('sha256', deriveEncryptionKey())
    .update(`${scope}\0${material}`, 'utf8')
    .digest('hex');
}

export function describeSecretStorage() {
  return {
    algorithm: 'aes-256-gcm',
    envelope: SECRET_BOX_PREFIX,
    // 返回实际 canonical key 文件，诊断页不会再把 profile-scoped key 误报成
    // local-api cwd 下的 legacy 默认路径。
    source: process.env.LOCAL_API_SECRET ? 'LOCAL_API_SECRET' : getSecretFilePath(),
    recoverable: true,
    publicResponse: 'settings lists return account identifiers, flags, and fixed masks; secret plaintext is never returned',
  };
}
