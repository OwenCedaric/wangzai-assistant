import { loadConfig } from '../src/config/loadConfig.js';
import { getStorageUsage } from '../src/utils/storageUsage.js';

const usage = getStorageUsage(loadConfig());

console.log(JSON.stringify(usage, null, 2));

if (!usage.ok) {
  process.exitCode = 1;
}
