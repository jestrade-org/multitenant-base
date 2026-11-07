import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Component tests: jsdom, because these assert what a person sees on the screen. */
export default defineConfig({
  // Pinned to this package: the workspace root config references this file, and without an
  // explicit root the include patterns would resolve against the repository root instead.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
