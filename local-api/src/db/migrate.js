import { initializeDatabase } from './database.js';
import { loadConfig } from '../config/loadConfig.js';

const config = loadConfig();
const { db, migrationsApplied, status } = initializeDatabase(config);

try {
  console.log(
    JSON.stringify(
      {
        ok: true,
        database: status,
        migrationsApplied,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
