import { decryptSecret, encryptSecret } from '../../security/secretCrypto.js';

const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9._-]{0,95}$/u;
const KEY_PATTERN = /^[^\u0000-\u001F\u007F]{1,500}$/u;
const INTERNAL_PROFILE_NAMESPACE = 'smart-reply-local-internal-v1';
const MAX_RECORDS = 10_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

function requiredText(value, pattern, code) {
  const normalized = String(value || '').trim();
  if (!pattern.test(normalized)) throw Object.assign(new Error(code), { code });
  return normalized;
}

function identity(input = {}) {
  return {
    scopeId: requiredText(input.scopeId, SCOPE_PATTERN, 'SMART_REPLY_SCOPE_INVALID'),
    namespace: requiredText(input.namespace, NAMESPACE_PATTERN, 'SMART_REPLY_NAMESPACE_INVALID'),
    key: requiredText(input.key, KEY_PATTERN, 'SMART_REPLY_RECORD_KEY_INVALID'),
  };
}

function clone(value) {
  return structuredClone(value ?? null);
}

function publicShopRows(shopRepository) {
  return shopRepository.listShops().map((shop) => {
    let credentials = null;
    try {
      credentials = shopRepository.getShopCredentialsForInternalUse(shop.id);
    } catch {
      credentials = null;
    }
    return {
      key: String(shop.id || ''),
      payload: {
        id: String(shop.id || ''),
        name: String(shop.name || ''),
        alias: String(shop.alias || ''),
        status: String(shop.status || 'inactive'),
        clientId: String(credentials?.clientId || shop.clientId || ''),
        apiKey: String(credentials?.apiKey || ''),
        boundAt: String(shop.boundAt || ''),
        updatedAt: String(shop.updatedAt || ''),
      },
      revision: Number(shop.credentialRevision) || 1,
      expiresAt: null,
      createdAt: String(shop.createdAt || ''),
      updatedAt: String(shop.updatedAt || ''),
    };
  });
}

/**
 * Compatibility store for the full-source desktop runtime.
 *
 * V2 persists these records in the encrypted Local Cache Agent. The full
 * development runtime already owns one registered profile_settings table, so
 * it keeps one private encrypted envelope there instead of creating another
 * unregistered business table. Shop credentials are read on demand from the
 * existing secret repository and are never copied into this envelope.
 */
export function createLocalSmartReplyRecordStore({ db, shopRepository } = {}) {
  if (!db || !shopRepository) throw new Error('SMART_REPLY_LOCAL_STORE_DEPENDENCIES_REQUIRED');
  const selectEnvelope = db.prepare(`
    SELECT value_json, created_at, updated_at
    FROM profile_settings WHERE namespace = ?
  `);
  const saveEnvelope = db.prepare(`
    INSERT INTO profile_settings (namespace, value_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace) DO UPDATE SET
      value_json=excluded.value_json,
      updated_at=excluded.updated_at
  `);

  function readEnvelope() {
    const row = selectEnvelope.get(INTERNAL_PROFILE_NAMESPACE);
    if (!row) return { records: [], createdAt: '' };
    try {
      const wrapper = JSON.parse(String(row.value_json || ''));
      const plaintext = decryptSecret(wrapper?.data);
      const parsed = JSON.parse(String(plaintext || ''));
      if (Number(parsed?.version) !== 1 || !Array.isArray(parsed?.records)) throw new Error();
      return {
        records: parsed.records,
        createdAt: String(row.created_at || ''),
      };
    } catch {
      throw Object.assign(new Error('SMART_REPLY_ENCRYPTED_PAYLOAD_INVALID'), {
        code: 'SMART_REPLY_ENCRYPTED_PAYLOAD_INVALID',
      });
    }
  }

  function writeEnvelope(envelope) {
    if (!Array.isArray(envelope.records) || envelope.records.length > MAX_RECORDS) {
      throw Object.assign(new Error('SMART_REPLY_RECORD_LIMIT_EXCEEDED'), {
        code: 'SMART_REPLY_RECORD_LIMIT_EXCEEDED',
      });
    }
    const plaintext = JSON.stringify({ version: 1, records: envelope.records });
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw Object.assign(new Error('SMART_REPLY_PAYLOAD_TOO_LARGE'), {
        code: 'SMART_REPLY_PAYLOAD_TOO_LARGE',
      });
    }
    const timestamp = new Date().toISOString();
    saveEnvelope.run(
      INTERNAL_PROFILE_NAMESPACE,
      JSON.stringify({ version: 1, data: encryptSecret(plaintext) }),
      envelope.createdAt || timestamp,
      timestamp,
    );
  }

  function findRecord(records, record) {
    return records.find((row) => (
      row.scopeId === record.scopeId
      && row.namespace === record.namespace
      && row.key === record.key
    ));
  }

  function publicRecord(row) {
    return row ? {
      key: row.key,
      payload: clone(row.payload),
      revision: Number(row.revision) || 1,
      expiresAt: row.expiresAt || null,
      createdAt: String(row.createdAt || ''),
      updatedAt: String(row.updatedAt || ''),
    } : null;
  }

  return Object.freeze({
    getRecord(input = {}) {
      const record = identity(input);
      if (record.namespace === 'shops') {
        return publicShopRows(shopRepository).find((row) => row.key === record.key) || null;
      }
      return publicRecord(findRecord(readEnvelope().records, record));
    },

    listRecords(input = {}) {
      const scopeId = requiredText(input.scopeId, SCOPE_PATTERN, 'SMART_REPLY_SCOPE_INVALID');
      const namespace = requiredText(
        input.namespace,
        NAMESPACE_PATTERN,
        'SMART_REPLY_NAMESPACE_INVALID',
      );
      const limit = Math.max(1, Math.min(1000, Number(input.limit) || 100));
      const offset = Math.max(0, Number(input.offset) || 0);
      if (namespace === 'shops') {
        return publicShopRows(shopRepository).slice(offset, offset + limit);
      }
      return readEnvelope().records
        .filter((row) => row.scopeId === scopeId && row.namespace === namespace)
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
        .slice(offset, offset + limit)
        .map(publicRecord);
    },

    listScopesByNamespace(namespaceValue) {
      const namespace = requiredText(
        namespaceValue,
        NAMESPACE_PATTERN,
        'SMART_REPLY_NAMESPACE_INVALID',
      );
      return [...new Set(readEnvelope().records
        .filter((row) => row.namespace === namespace)
        .map((row) => String(row.scopeId || ''))
        .filter(Boolean))].sort();
    },

    putRecord(input = {}) {
      const record = identity(input);
      if (record.namespace === 'shops') {
        throw Object.assign(new Error('SMART_REPLY_SHOP_RECORD_READ_ONLY'), {
          code: 'SMART_REPLY_SHOP_RECORD_READ_ONLY',
        });
      }
      const envelope = readEnvelope();
      const existing = findRecord(envelope.records, record);
      const timestamp = new Date().toISOString();
      const saved = {
        ...record,
        payload: clone(input.payload),
        revision: existing ? Number(existing.revision || 1) + 1 : 1,
        expiresAt: input.expiresAt ? String(input.expiresAt) : null,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      if (existing) Object.assign(existing, saved);
      else envelope.records.push(saved);
      writeEnvelope(envelope);
      return publicRecord(saved);
    },

    deleteRecord(input = {}) {
      const record = identity(input);
      if (record.namespace === 'shops') return { deleted: false };
      const envelope = readEnvelope();
      const before = envelope.records.length;
      envelope.records = envelope.records.filter((row) => !(
        row.scopeId === record.scopeId
        && row.namespace === record.namespace
        && row.key === record.key
      ));
      if (envelope.records.length !== before) writeEnvelope(envelope);
      return { deleted: envelope.records.length !== before };
    },
  });
}
