import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const libsDir = fileURLToPath(new URL('./libs/', import.meta.url));

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  resolve: {
    // The libs' tsconfig.lib.json exclude spec files, so the plugin above does
    // not resolve `@libs/*` inside them. Mirror the tsconfig paths here.
    alias: [
      { find: /^@libs\/([^/]+)$/, replacement: `${libsDir}$1/src/index.ts` },
      { find: /^@libs\/([^/]+)\/(.*)$/, replacement: `${libsDir}$1/src/$2` },
    ],
  },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
