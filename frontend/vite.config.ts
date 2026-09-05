import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Resolve the shared workspace straight to source. Vite does not transform node_modules by
      // default, and @bg/shared is a symlinked workspace package containing TypeScript, so this
      // alias is what keeps it working without a separate build step (design §2).
      '@bg/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxying keeps the browser same-origin in development, so the API and the socket transport
      // behave the same way they would behind a single deployed origin.
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/live': {
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    passWithNoTests: true,
  },
});
