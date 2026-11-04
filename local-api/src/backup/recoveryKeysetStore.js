import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../security/secretCrypto.js';
import {
  createRecoveryKeyEnvelope,
  generateRecoveryKeyset,
  openRecoveryKeyEnvelope,
} from './recoveryKeyEnvelope.js';

const STATE_ID = 'default';

function fail(code) {
  throw new Error(code);
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value, code) {
  const text = String(value || '').trim();
  if (!text) fail(code);
  return Buffer.from(text, 'base64url');
}

function assertKeyset(keyset) {
  const chunkEncryptionKey = Buffer.isBuffer(keyset?.chunkEncryptionKey)
    ? keyset.chunkEncryptionKey
    : Buffer.from(keyset?.chunkEncryptionKey || '');
  const dedupeKey = Buffer.isBuffer(keyset?.dedupeKey)
    ? keyset.dedupeKey
    : Buffer.from(keyset?.dedupeKey || '');
  if (chunkEncryptionKey.length !== 32 || dedupeKey.length !== 32) fail('RECOVERY_KEYSET_INVALID');
  return { chunkEncryptionKey, dedupeKey };
}

function serializeKeyset(keyset) {
  const normalized = assertKeyset(keyset);
  return JSON.stringify({
    version: 1,
    chunkEncryptionKeyB64u: toBase64Url(normalized.chunkEncryptionKey),
    dedupeKeyB64u: toBase64Url(normalized.dedupeKey),
  });
}

function parseKeyset(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch {
    fail('RECOVERY_KEYSET_STATE_INVALID');
  }
  if (parsed?.version !== 1) fail('RECOVERY_KEYSET_STATE_INVALID');
  return assertKeyset({
    chunkEncryptionKey: fromBase64Url(parsed.chunkEncryptionKeyB64u, 'RECOVERY_KEYSET_STATE_INVALID'),
    dedupeKey: fromBase64Url(parsed.dedupeKeyB64u, 'RECOVERY_KEYSET_STATE_INVALID'),
  });
}

function parseEnvelope(value) {
  try {
    const envelope = JSON.parse(String(value || ''));
    if (envelope?.format !== 'wangzai-recovery-key-envelope' || envelope.version !== 1 || typeof envelope.aad !== 'string') {
      fail('RECOVERY_KEYSET_ENVELOPE_INVALID');
    }
    return envelope;
  } catch (error) {
    if (String(error?.message || '').startsWith('RECOVERY_')) throw error;
    fail('RECOVERY_KEYSET_ENVELOPE_INVALID');
  }
}

function normalizeAad(value) {
  const aad = String(value || '').trim();
  if (!/^wangzai-recovery:v1:profile:[A-Za-z0-9-]{20,128}$/u.test(aad)) {
    fail('RECOVERY_AAD_INVALID');
  }
  return aad;
}

/** Local encrypted state only. The portable copy is the separately passphrase-wrapped envelope. */
export function createRecoveryKeysetStore({
  db,
  encrypt = encryptSecret,
  decrypt = decryptSecret,
  randomUuid = randomUUID,
} = {}) {
  if (!db) throw new Error('createRecoveryKeysetStore requires db.');
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') {
    throw new Error('createRecoveryKeysetStore requires encrypt/decrypt functions.');
  }

  function readState() {
    const row = db.prepare(`
      SELECT keyset_encrypted, key_envelope_json, recovery_aad
      FROM recovery_local_state WHERE id = ?
    `).get(STATE_ID);
    if (!row) return null;
    const plaintext = decrypt(row.keyset_encrypted);
    if (!plaintext) fail('RECOVERY_KEYSET_DECRYPT_FAILED');
    const keyset = parseKeyset(plaintext);
    const envelope = parseEnvelope(row.key_envelope_json);
    const recoveryAad = normalizeAad(row.recovery_aad);
    if (envelope.aad !== recoveryAad) fail('RECOVERY_KEYSET_AAD_MISMATCH');
    return { keyset, envelope, recoveryAad };
  }

  function saveState({ keyset, envelope } = {}) {
    const normalizedKeyset = assertKeyset(keyset);
    const normalizedEnvelope = parseEnvelope(JSON.stringify(envelope));
    const recoveryAad = normalizeAad(normalizedEnvelope.aad);
    const encrypted = encrypt(serializeKeyset(normalizedKeyset));
    if (!encrypted) fail('RECOVERY_KEYSET_ENCRYPT_FAILED');
    db.prepare(`
      INSERT INTO recovery_local_state (id, keyset_encrypted, key_envelope_json, recovery_aad, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        keyset_encrypted = excluded.keyset_encrypted,
        key_envelope_json = excluded.key_envelope_json,
        recovery_aad = excluded.recovery_aad,
        updated_at = excluded.updated_at
    `).run(STATE_ID, encrypted, JSON.stringify(normalizedEnvelope), recoveryAad);
    return { keyset: normalizedKeyset, envelope: normalizedEnvelope, recoveryAad };
  }

  function initialize({ passphrase } = {}) {
    const existing = readState();
    if (existing) return existing;
    const recoveryAad = `wangzai-recovery:v1:profile:${randomUuid()}`;
    const keyset = generateRecoveryKeyset();
    const envelope = createRecoveryKeyEnvelope({ keyset, passphrase, aad: recoveryAad });
    return saveState({ keyset, envelope });
  }

  function restoreFromEnvelope({ envelope, passphrase } = {}) {
    const recoveryAad = normalizeAad(envelope?.aad);
    const keyset = openRecoveryKeyEnvelope({ envelope, passphrase, aad: recoveryAad });
    return saveState({ keyset, envelope });
  }

  function getStatus() {
    const state = readState();
    return {
      enrolled: Boolean(state),
      portableEnvelope: Boolean(state?.envelope),
      localKeysetEncrypted: Boolean(state),
    };
  }

  return { readState, saveState, initialize, restoreFromEnvelope, getStatus };
}
