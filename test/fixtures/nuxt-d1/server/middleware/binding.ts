import { defineEventHandler } from 'nuxt/server'
import type { AnyD1Database } from 'drizzle-orm/d1'
// Synthetic request-local tenant selection; never mutate the shared Worker env.
export default defineEventHandler((event) => {
    if (event.req.headers.get('x-site-admin-test-database') !== 'alternate') return
    const platform = event.context.cloudflare as { env: { DB: AnyD1Database; ALT_DB: AnyD1Database } }
    event.context.cloudflare = { ...platform, env: { ...platform.env, DB: platform.env.ALT_DB } }
})
