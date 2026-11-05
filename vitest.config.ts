import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * One run over every package. The ported packages keep their own
 * vitest.config.ts too, so `cd packages/hepta && npx vitest run` still works
 * the way it did in tacit.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@intermenu/aiuic-core': at('./packages/core/src/index.ts'),
      '@intermenu/aiuic-resolve': at('./packages/resolve/src/index.ts'),
      '@intermenu/aiuic-memory': at('./packages/memory/src/index.ts'),
      '@intermenu/hepta': at('./packages/hepta/src/index.ts'),
      '@intermenu/aiuic-pyramid': at('./packages/pyramid/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'bench/test/**/*.test.ts'],
  },
});
