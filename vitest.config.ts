import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    alias: {
      // 對應 tsconfig.json 的 paths：`@/*` -> 專案根目錄
      '@/': fileURLToPath(new URL('.', import.meta.url)),
    },
    setupFiles: ['./test/setup.ts'],
    mockReset: true,
    unstubEnvs: true,
  },
})
