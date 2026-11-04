import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const localApiRoot = fileURLToPath(new URL('../..', import.meta.url));
const environmentPath = resolve(
  process.env.LOCAL_API_ENV_PATH || resolve(localApiRoot, '.env.local'),
);

if (existsSync(environmentPath)) {
  process.loadEnvFile(environmentPath);
}

