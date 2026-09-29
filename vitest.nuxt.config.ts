import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['test/nuxt/*.test.ts'],
        testTimeout: 120_000,
        hookTimeout: 240_000,
        fileParallelism: false,
    },
})
