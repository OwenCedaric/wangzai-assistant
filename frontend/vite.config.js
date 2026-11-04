import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import localDataPlugin from './localDataPlugin.js';
import { v2UiCoveragePlugin } from './scripts/v2-ui-coverage-plugin.mjs';

// An open Electron renderer keeps the hashed chunks from the build it started with.
// Retaining prior chunks prevents a background/source build from turning a lazy route
// request into index.html (and therefore a MIME-type / dynamic-import crash).
const shouldCleanFrontendDist = process.env.WANGZAI_CLEAN_FRONTEND_DIST === '1';

export default defineConfig({
  plugins: [v2UiCoveragePlugin(), react(), localDataPlugin()],
  resolve: {
    dedupe: ['@emotion/react', '@emotion/styled', '@mui/material', '@mui/system'],
  },
  build: {
    emptyOutDir: shouldCleanFrontendDist,
    // The two primary workspaces are intentionally synchronous (see
    // criticalRouteLoading.test.js) so they cannot fail on a late route chunk.
    // Their combined shell is ~250 KiB gzip; keep the warning threshold just
    // above the measured uncompressed boundary and guard the route contract in tests.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');
          if (normalizedId.includes('/src/data/')) return 'app-data';
          if (normalizedId.includes('/src/features/products/')) return 'feature-products';
          if (!normalizedId.includes('node_modules')) return undefined;
          if (normalizedId.includes('/echarts/') || normalizedId.includes('/zrender/')) return 'vendor-charts';
          return 'vendor-ui';
        },
      },
    },
  },
  server: {
    allowedHosts: true,
  },
  test: {
    // Bridge scripts use node:test and have their own desktop gate. Letting
    // Vitest collect them executes the TAP file but then reports an empty
    // Vitest suite, making the combined frontend gate nondeterministic.
    exclude: [...configDefaults.exclude, 'scripts/**/*.test.mjs'],
  },
});
