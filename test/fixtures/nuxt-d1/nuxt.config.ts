import { defineNuxtConfig } from 'nuxt/config'
import siteAdmin from '@liria24/site-admin/nuxt'
import type { NitroConfig } from 'nitropack/types'
import { fileURLToPath } from 'node:url'

const nitro = { preset: 'cloudflare-module', static: false, cloudflare: { nodeCompat: true } } satisfies NitroConfig
const databaseFile = fileURLToPath(new URL('./server/database.ts', import.meta.url))
const schemaFile = fileURLToPath(new URL('./.data/schema/schema.ts', import.meta.url))

export default defineNuxtConfig({
    devtools: { enabled: false },
    modules: [siteAdmin],
    hooks: {
        'better-auth:database:providers'(providers) {
            providers.application = {
                priority: 1_000,
                isEnabled: () => true,
                buildDatabaseCode: ({ usePlural }) => `
import { getAppDb } from ${JSON.stringify(databaseFile)}
import * as schema from ${JSON.stringify(schemaFile)}
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { getHeader } from 'h3'
export const db = undefined
export function createDatabase(event) {
    if (!event) throw new Error('A request context is required for the application D1 auth database.')
    const platformContext = {
        ...event.context,
        cloudflare: event.context.cloudflare,
        testDatabase: getHeader(event, 'x-site-admin-test-database'),
    }
    return drizzleAdapter(getAppDb({ platformContext }), {
        provider: 'sqlite', schema, transaction: false, usePlural: ${JSON.stringify(usePlural)},
    })
}
`,
            }
        },
    },
    siteAdmin: {
        auth: true,
        i18n: false,
        llms: false,
        ogImage: false,
        robots: false,
        routing: { enabled: false },
        schemaOrg: false,
        seo: false,
        sitemap: false,
    },
    nitro,
})
