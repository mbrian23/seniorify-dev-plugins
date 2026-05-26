import { defineConfig } from 'vitest/config';

// Shared config; per-suite settings live in vitest.workspace.ts.
export default defineConfig({
  test: {
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
});
