const quote = value => `"${String(value).replaceAll('"', '""')}"`;

/** Read-only overflow for SQLite's ATTACH ceiling. TEMP data is never authoritative. */
export function materializeShopReadTables(target, sources, tables, profitShopIds, legacyShopIds = []) {
  target.exec('PRAGMA temp_store = FILE;');
  for (const table of [...tables, 'profit_ledger_snapshots']) {
    const profit = table === 'profit_ledger_snapshots';
    const available = sources.filter(source => (!profit || profitShopIds.includes(source.shopId))
      && source.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    if (!available.length) {
      if (!profit && target.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table)) {
        const scope = [...new Set([...legacyShopIds, ...sources.map(source => source.shopId)])];
        target.exec(`CREATE TEMP TABLE ${quote(table)} AS SELECT * FROM main.${quote(table)} WHERE 0;`);
        if (scope.length) target.prepare(`INSERT INTO temp.${quote(table)} SELECT * FROM main.${quote(table)} WHERE shop_id IN (${scope.map(() => '?').join(',')})`).run(...scope);
      }
      continue;
    }
    target.exec(`CREATE TEMP TABLE ${quote(table)} AS SELECT * FROM main.${quote(table)} WHERE 0;`);
    if (profit) target.exec(`INSERT INTO temp.${quote(table)} SELECT * FROM main.${quote(table)};`);
    else {
      const legacy = [...legacyShopIds, ...sources.filter(source => !available.includes(source)).map(source => source.shopId)];
      if (legacy.length) target.prepare(`INSERT INTO temp.${quote(table)} SELECT * FROM main.${quote(table)}
        WHERE shop_id IN (${legacy.map(() => '?').join(',')})`).run(...legacy);
    }
    const columns = target.prepare(`PRAGMA temp.table_info(${quote(table)})`).all().map(row => row.name);
    const insert = target.prepare(`INSERT INTO temp.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    for (const source of available) {
      const actualColumns = source.db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
      if (JSON.stringify(actualColumns) !== JSON.stringify(columns)) {
        throw Object.assign(new Error('SHOP_FEDERATED_SCHEMA_MISMATCH'), { code: 'SHOP_FEDERATED_SCHEMA_MISMATCH', shopId: source.shopId, table });
      }
      const query = profit ? `SELECT * FROM ${quote(table)}` : `SELECT * FROM ${quote(table)} WHERE shop_id=?`;
      for (const row of source.db.prepare(query).iterate(...(profit ? [] : [source.shopId]))) {
        insert.run(...columns.map(column => row[column]));
      }
    }
  }
}
