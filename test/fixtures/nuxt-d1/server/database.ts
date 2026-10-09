import { drizzle, type AnyD1Database } from 'drizzle-orm/d1'
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'
import type { SiteAdminDatabase } from '@liria24/site-admin/adapter'
import type { SiteAdminDatabaseContext } from '@liria24/site-admin/runtime/database'
// @ts-ignore The consumer test generates its application-owned schema before building.
import * as schema from '../.data/schema/schema'

const databases = new WeakMap<object, ReturnType<typeof drizzle>>()
const adapters = new WeakMap<object, SiteAdminDatabase>()

/** Binding selection and native-client caching are application responsibilities. */
export const getAppDb = (context: SiteAdminDatabaseContext) => {
    const platform = (context.platformContext ?? context.event?.context) as
        | { testDatabase?: string; cloudflare?: { env?: { DB?: AnyD1Database; ALT_DB?: AnyD1Database } } }
        | undefined
    const selected =
        context.request?.headers.get('x-site-admin-test-database') ??
        context.event?.req.headers.get('x-site-admin-test-database') ??
        platform?.testDatabase
    const binding = selected === 'alternate' ? platform?.cloudflare?.env?.ALT_DB : platform?.cloudflare?.env?.DB
    if (!binding) throw new Error('The selected application D1 binding is unavailable.')
    let database = databases.get(binding)
    if (!database) {
        database = drizzle(binding, { relations: schema.authRelations })
        databases.set(binding, database)
    }
    return database
}

export const getSiteAdminDatabase = (context: SiteAdminDatabaseContext): SiteAdminDatabase => {
    const database = getAppDb(context)
    let adapter = adapters.get(database)
    if (!adapter) {
        adapter = drizzleAdapter(database, { schema })
        adapters.set(database, adapter)
    }
    return adapter
}
