import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No path aliases: resolving tsconfig paths would walk up into the app repo's tsconfig.
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
