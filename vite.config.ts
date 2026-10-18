import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // es2022, lowered where older phone browsers lack it (class static blocks need Safari 16.4)
    target: ['es2022', 'safari15', 'chrome100', 'firefox100'],
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
  server: { port: 5173, host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
  },
} as any);
