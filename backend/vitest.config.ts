import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the tsconfig path mapping so tests resolve the shared workspace from source,
      // exactly as the running server does.
      '@bg/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Tests arrive with the modules they cover, starting in task 2. Until then an empty run is a
    // pass, not a failure, so `npm test` stays usable as a gate from the first commit.
    passWithNoTests: true,
    // The engine is deterministic and tick-driven, so tests never need real time to pass.
    testTimeout: 15_000,
  },
});
