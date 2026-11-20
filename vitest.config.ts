import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['packages/**/*.test.ts', 'apps/worker/**/*.test.ts'], testTimeout: 30000, env: { NOVA_ALLOW_MOCK: 'true' } },
});
