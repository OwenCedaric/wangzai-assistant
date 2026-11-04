import { initializeDatabase } from '../src/db/database.js';
import { loadConfig } from '../src/config/loadConfig.js';

const config = loadConfig();
const { db, migrationsApplied, status } = initializeDatabase(config);

try {
  const migrationRows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  const baseTables = ['shops', 'sync_jobs', 'sync_state'];
  const missingTables = baseTables.filter((tableName) => !status.tables.includes(tableName));

  console.log(
    JSON.stringify(
      {
        ok: missingTables.length === 0,
        database: status,
        migrationsApplied,
        migrations: migrationRows,
        requiredTables: baseTables,
        missingTables,
      },
      null,
      2,
    ),
  );

  if (missingTables.length > 0) {
    process.exitCode = 1;
  }
} finally {
  db.close();
}
