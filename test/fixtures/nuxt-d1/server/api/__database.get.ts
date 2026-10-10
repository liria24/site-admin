import { defineEventHandler } from 'nuxt/server'
import type { AnyD1Database } from 'drizzle-orm/d1'
import { getAppDb, getSiteAdminDatabase } from '../database'

export default defineEventHandler(async (event) => {
    const context = { event }
    const database = getAppDb(context)
    const adapter = getSiteAdminDatabase(context)
    const binding = database.$client
    const freshContext = { platformContext: { cloudflare: { env: { DB: binding } } } }
    // A delegated test binding exercises app cache identity without adding a second database.
    const alternateBinding = {
        prepare: binding.prepare.bind(binding),
        batch: binding.batch.bind(binding),
    } as AnyD1Database
    const alternateContext = { platformContext: { cloudflare: { env: { DB: alternateBinding } } } }
    const users = (await binding.prepare('SELECT COUNT(*) AS count FROM user').all<{ count: number }>()).results
    return {
        users: Number(users[0]?.count ?? 0),
        sameClientInFreshContext: getAppDb(freshContext) === database,
        sameAdapterInFreshContext: getSiteAdminDatabase(freshContext) === adapter,
        alternateClientIsolated: getAppDb(alternateContext) !== database,
        alternateAdapterIsolated: getSiteAdminDatabase(alternateContext) !== adapter,
        alternateClientOwnsBinding: getAppDb(alternateContext).$client === alternateBinding,
    }
})
