import { createHash } from 'node:crypto';

const MAX_PROFILE_ASSET_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function nowIso() {
  return new Date().toISOString();
}

function normalizeMimeType(value) {
  const mimeType = String(value ?? '').trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) throw new Error('Profile asset MIME type is not allowed.');
  return mimeType;
}

function normalizeBase64(value) {
  const base64 = String(value ?? '').trim();
  if (!base64 || base64.startsWith('data:') || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
    throw new Error('Profile asset must use canonical base64 data.');
  }
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.toString('base64') !== base64) throw new Error('Profile asset base64 is invalid.');
  if (data.byteLength > MAX_PROFILE_ASSET_BYTES) throw new Error('Profile asset exceeds the 1 MiB limit.');
  return data;
}

function publicAsset(row = {}, { includeData = false } = {}) {
  if (!row?.id) return null;
  return {
    id: row.id,
    sha256: row.sha256,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    ...(includeData ? { dataBase64: row.data_base64 } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeProfileAssetInput(input = {}) {
  const mimeType = normalizeMimeType(input.mimeType ?? input.mime_type);
  const data = normalizeBase64(input.dataBase64 ?? input.data_base64);
  return {
    mimeType,
    data,
    dataBase64: data.toString('base64'),
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

export function createProfileAssetRepository(db) {
  const selectSql = 'SELECT id, sha256, mime_type, byte_length, data_base64, created_at, updated_at FROM profile_assets';
  const getRow = (id) => db.prepare(`${selectSql} WHERE id = ?`).get(String(id ?? '').trim()) || null;

  function getAsset(id, options = {}) {
    const row = getRow(id);
    return row ? publicAsset(row, options) : null;
  }

  function saveAsset(input = {}) {
    const { mimeType, data, sha256 } = normalizeProfileAssetInput(input);
    const existing = db.prepare(`${selectSql} WHERE sha256 = ?`).get(sha256) || null;
    if (existing) return { ok: true, created: false, asset: publicAsset(existing) };
    const timestamp = nowIso();
    const id = `asset_${sha256}`;
    db.prepare(`
      INSERT INTO profile_assets (id, sha256, mime_type, byte_length, data_base64, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, sha256, mimeType, data.byteLength, data.toString('base64'), timestamp, timestamp);
    return { ok: true, created: true, asset: publicAsset(getRow(id)) };
  }

  function deleteAssetIfUnreferenced(id) {
    const assetId = String(id ?? '').trim();
    if (!assetId) return { ok: true, deleted: false, reason: 'asset_id_missing' };
    const reference = db.prepare(`
      SELECT 1
      FROM product_image_assets
      WHERE profile_asset_id = ? AND status <> 'deleted'
      LIMIT 1
    `).get(assetId);
    if (reference) return { ok: true, deleted: false, reason: 'still_referenced' };
    const result = db.prepare('DELETE FROM profile_assets WHERE id = ?').run(assetId);
    return { ok: true, deleted: Number(result.changes || 0) > 0 };
  }

  return { getAsset, saveAsset, deleteAssetIfUnreferenced };
}
