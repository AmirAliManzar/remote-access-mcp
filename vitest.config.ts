import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ADR-006: hermetic tests — isolate HOME before any src module import,
    // so parallel workers never write/read a shared real-user config.
    setupFiles: ['tests/setup/hermetic-home.ts'],
  },
});
