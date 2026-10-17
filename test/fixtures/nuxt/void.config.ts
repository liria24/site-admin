import { defineConfig } from 'void/config'
export default defineConfig({
    inference: { bindings: { db: true } },
    cloudflare: {
        name: 'site-admin-nuxt-test',
        compatibility_date: '2026-10-15',
        compatibility_flags: ['nodejs_compat'],
    },
})
