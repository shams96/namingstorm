/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    // Fork-based workers take 60-90s+ to spin up in this environment
    // (sandboxed Windows child_process spawning), tripping vitest's default
    // worker-response timeout. Threads start in a few seconds instead.
    pool: 'threads',
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/*.test.ts', 'server.test.ts'],
          setupFiles: ['src/test/setup-node.ts'],
          globals: true,
        },
      },
      {
        extends: './vite.config.ts',
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          setupFiles: ['src/setupTests.ts'],
          globals: true,
        },
      },
    ],
  },
});
