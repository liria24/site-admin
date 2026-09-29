import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        coverage: { enabled: false },
        include: ['test/**/*.test.ts'],
        exclude: ['test/nuxt/**', 'test/fixtures/**'],
        testTimeout: 20_000,
    },
})
