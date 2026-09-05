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
    /**
     * Silence the application logger during tests.
     *
     * The API suite deliberately exercises dozens of rejected requests, and each one logs a warning with its
     * full validation detail. Left on, a passing run buries its own summary under hundreds of lines and a real
     * failure becomes genuinely hard to find. Set `LOG_LEVEL=warn` on the command line to get them back when
     * debugging a specific case.
     */
    env: { LOG_LEVEL: 'silent' },
    // Tests arrive with the modules they cover, starting in task 2. Until then an empty run is a
    // pass, not a failure, so `npm test` stays usable as a gate from the first commit.
    passWithNoTests: true,
    // The engine is deterministic and tick-driven, so tests never need real time to pass.
    testTimeout: 15_000,
  },
});
