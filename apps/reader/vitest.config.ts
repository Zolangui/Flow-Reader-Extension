import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@flow/reader': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
