import { DatabaseSync } from 'node:sqlite';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('DATABASE_PATH_REQUIRED');
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const matches = [];
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const columns = database.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all();
    for (const column of columns) {
      if (!/(?:TEXT|CHAR|CLOB)/iu.test(String(column.type || ''))) continue;
      let count = 0;
      try {
        count = Number(database.prepare(
          `SELECT COUNT(*) AS count FROM ${JSON.stringify(name)} WHERE ${JSON.stringify(column.name)} LIKE '%yangkeduo%'`,
        ).get().count) || 0;
      } catch { /* skip virtual or incompatible tables */ }
      if (count) matches.push({ table: name, column: column.name, count });
    }
  }
  console.log(JSON.stringify(matches, null, 2));
} finally {
  database.close();
}
