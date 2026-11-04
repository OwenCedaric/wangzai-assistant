import { configDefaults, defineConfig } from 'vitest/config';
import { v2UiCoveragePlugin } from './scripts/v2-ui-coverage-plugin.mjs';

export default defineConfig({
  plugins: [v2UiCoveragePlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    restoreMocks: true,
    clearMocks: true,
    // The full 2k+ test run shares CPU across hundreds of jsdom workers; keep
    // interaction-heavy MUI suites from failing only because of scheduler lag.
    testTimeout: 15_000,
    // Hundreds of jsdom suites can otherwise saturate the machine and make
    // healthy interaction tests miss their own timeout. A fixed worker cap
    // keeps the complete gate deterministic on both development and CI hosts.
    maxWorkers: 4,
    // purchase-bridge uses node:test and is executed by the Desktop bridge
    // gate. Vitest would run its TAP body and then reject the file as an empty
    // Vitest suite.
    exclude: [...configDefaults.exclude, 'scripts/**/*.test.mjs'],
  },
});
