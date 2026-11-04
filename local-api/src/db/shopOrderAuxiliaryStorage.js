import { isDeepStrictEqual } from 'node:util';

const TABLES = Object.freeze(['historical_order_facts', 'ozon_order_split_relations']);

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function columnType(value) {
  const type = text(value).toUpperCase() || 'BLOB';
  if (!/^[A-Z0-9_ ()]+$/u.test(type)) throw new Error('SHOP_ORDER_AUXILIARY_COLUMN_TYPE_INVALID');
  return type;
}

function defaultSql(value) {
  if (value === null || value === undefined) return '';
  const valueText = text(value);
  if (/^[-+]?\d+(?:\.\d+)?$/u.test(valueText)
    || /^NULL$/iu.test(valueText)
    || /^CURRENT_(?:TIME|DATE|TIMESTAMP)$/iu.test(valueText)
    || /^'(?:[^']|'')*'$/u.test(valueText)) return ` DEFAULT ${valueText}`;
  return ` DEFAULT (${valueText})`;
}

function descriptor(db, tableName) {
  const columns = db.prepare(`PRAGMA table_info(${quote(tableName)})`).all().map((column) => ({
    name: String(column.name),
    type: columnType(column.type),
    notNull: Number(column.notnull) === 1,
    defaultValue: column.dflt_value === undefined ? null : column.dflt_value,
    primaryKey: Number(column.pk) || 0,
  }));
  const primaryKey = columns.filter((column) => column.primaryKey > 0)
    .sort((left, right) => left.primaryKey - right.primaryKey);
  if (!columns.some((column) => column.name === 'shop_id') || !primaryKey.length) {
    const error = new Error('SHOP_ORDER_AUXILIARY_SCHEMA_INVALID');
    error.code = 'SHOP_ORDER_AUXILIARY_SCHEMA_INVALID';
    error.tableName = tableName;
    throw error;
  }
  const indexes = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
    ORDER BY name ASC
  `).all(tableName).map((row) => text(row.sql)).filter(Boolean);
  const uniqueIndexes = db.prepare(`PRAGMA index_list(${quote(tableName)})`).all()
    .filter((index) => Number(index.unique) === 1 && text(index.origin) === 'u')
    .map((index) => db.prepare(`PRAGMA index_info(${quote(index.name)})`).all()
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((column) => text(column.name)).filter(Boolean))
    .filter((columnsList) => columnsList.length > 0);
  return { tableName, columns, primaryKey, indexes, uniqueIndexes };
}

function tableSql(item) {
  const definitions = item.columns.map((column) =>
    `${quote(column.name)} ${column.type}${column.notNull ? ' NOT NULL' : ''}${defaultSql(column.defaultValue)}`);
  definitions.push(`PRIMARY KEY (${item.primaryKey.map((column) => quote(column.name)).join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${quote(item.tableName)} (${definitions.join(', ')});`;
}

export function createShopOrderAuxiliaryStorage(canonicalDb) {
  const descriptors = TABLES.map((tableName) => descriptor(canonicalDb, tableName));

  function ensureSchema(db) {
    for (const item of descriptors) {
      db.exec(tableSql(item));
      for (const indexSql of item.indexes) {
        const sql = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/iu.test(indexSql)
          ? indexSql
          : indexSql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/iu, (_match, unique = '') => `CREATE ${unique || ''}INDEX IF NOT EXISTS `);
        db.exec(`${sql};`);
      }
      item.uniqueIndexes.forEach((columns, index) => db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`uq_shop_order_${item.tableName}_${index + 1}`)}
        ON ${quote(item.tableName)} (${columns.map(quote).join(', ')});
      `));
    }
  }

  function copyShopRows(targetDb, shopId) {
    let copied = 0;
    for (const item of descriptors) {
      const columnNames = item.columns.map((column) => column.name);
      const columns = columnNames.map(quote).join(', ');
      const orderBy = item.primaryKey.map((column) => quote(column.name)).join(', ');
      const rows = canonicalDb.prepare(`SELECT ${columns} FROM ${quote(item.tableName)} WHERE shop_id = ? ORDER BY ${orderBy}`).all(shopId);
      targetDb.prepare(`DELETE FROM ${quote(item.tableName)}`).run();
      const insert = targetDb.prepare(`INSERT INTO ${quote(item.tableName)} (${columns}) VALUES (${columnNames.map(() => '?').join(', ')})`);
      for (const row of rows) insert.run(...columnNames.map((column) => row[column]));
      const targetRows = targetDb.prepare(`SELECT ${columns} FROM ${quote(item.tableName)} WHERE shop_id = ? ORDER BY ${orderBy}`).all(shopId);
      if (!isDeepStrictEqual(rows, targetRows)) {
        const error = new Error('SHOP_ORDER_AUXILIARY_COPY_MISMATCH');
        error.code = 'SHOP_ORDER_AUXILIARY_COPY_MISMATCH';
        error.tableName = item.tableName;
        throw error;
      }
      copied += rows.length;
    }
    return copied;
  }

  return Object.freeze({ ensureSchema, copyShopRows });
}
