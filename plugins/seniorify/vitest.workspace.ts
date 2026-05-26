import { defineWorkspace } from 'vitest/config';

// Three workspaces: unit, contract, integration. Per Constitution §II,
// integration tests run against a real backend; the setupFile fails fast
// if SENIORIFY_BACKEND_URL is unset.
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'contract',
      include: ['tests/contract/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['tests/integration/_require-backend.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  },
]);
