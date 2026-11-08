import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createBackendProxy } from './backendProxy.js'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/test-runtime': {
        ...createBackendProxy(process.env.WANGZAI_ADMIN_TEST_BACKEND_URL || 'http://127.0.0.1:18000', process.env.WANGZAI_ADMIN_TEST_CA_FILE),
        rewrite: (path) => path.replace(/^\/test-runtime/, ''),
      },
      '/api': {
        ...createBackendProxy(process.env.WANGZAI_ADMIN_BACKEND_URL || 'http://127.0.0.1:8000', process.env.WANGZAI_ADMIN_CA_FILE),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
  },
})
