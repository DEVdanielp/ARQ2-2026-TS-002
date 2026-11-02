import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: 'apps/orders-service',
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
  },
});
