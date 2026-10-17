import { db } from 'void/db'
import { getRuntimeBinding } from 'void/_env'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { createD1Database } from '../adapters/database'
import { SiteAdminError } from '../errors'
import { withSiteAdminContext } from './context'

type Client = Parameters<typeof createD1Database>[0]
const databases = new WeakMap<object, WeakMap<object, ReturnType<typeof createD1Database>>>()

/** Cache schema/storage by binding, but resolve Void's session for each operation. */
export const useVoidDatabase = (schema: Record<string, unknown>) => {
    const binding = getRuntimeBinding('DB')
    if (!binding || typeof binding !== 'object')
        throw new SiteAdminError('SITE_ADMIN_DATABASE_UNSUPPORTED', 'Site Admin requires Void with a D1 database.')
    let schemas = databases.get(binding)
    if (!schemas) databases.set(binding, (schemas = new WeakMap()))
    let database = schemas.get(schema)
    if (!database) {
        const client = new Proxy({} as Client, {
            get(_target, property) {
                const native = (db as unknown as { $client: Client }).$client
                const value = Reflect.get(native, property)
                return typeof value === 'function' ? value.bind(native) : value
            },
        })
        database = createD1Database(client, schema)
        schemas.set(schema, database)
    }
    return database
}

/** Auth uses the same Void session without initializing CMS tables or running migrations. */
export const createAuthDatabase = (
    schema: Record<string, unknown>,
    options: { usePlural?: boolean; camelCase?: boolean } = {},
    context?: object,
) => {
    const factory = drizzleAdapter(db, { ...options, provider: 'sqlite', schema, transaction: false })
    return (authOptions: Parameters<typeof factory>[0]) => {
        const adapter = factory(authOptions)
        for (const [name, value] of Object.entries(adapter))
            if (typeof value === 'function')
                Object.assign(adapter, {
                    [name]: (...args: unknown[]) =>
                        withSiteAdminContext(context, () => Reflect.apply(value, adapter, args)),
                })
        return adapter
    }
}
