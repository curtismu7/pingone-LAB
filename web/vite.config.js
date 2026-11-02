import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5501,
    proxy: { '/api': 'http://127.0.0.1:5500' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testSetup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
    testTimeout: 30000,
  },
});
