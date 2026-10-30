import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const libsDir = fileURLToPath(new URL('./libs/', import.meta.url));

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // test/ folders are outside every tsconfig, so the plugin above does not
    // resolve `@libs/*` there. Same aliases as vitest.config.ts.
    alias: [
      { find: /^@libs\/([^/]+)$/, replacement: `${libsDir}$1/src/index.ts` },
      { find: /^@libs\/([^/]+)\/(.*)$/, replacement: `${libsDir}$1/src/$2` },
    ],
  },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['reflect-metadata'],
    // Integration tests share one database; run the files one after another.
    fileParallelism: false,
  },
});
