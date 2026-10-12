import { defineConfig } from 'vitest/config';

const integration = process.env.VITEST_INTEGRATION === '1';

export default defineConfig({
  test: {
    include: integration ? ['test/integration/**/*.test.ts'] : ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: integration ? 60_000 : 10_000,
    hookTimeout: integration ? 120_000 : 10_000,
    // Integration tests share one local database; run them serially.
    fileParallelism: !integration,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin/**'],
    },
  },
});
