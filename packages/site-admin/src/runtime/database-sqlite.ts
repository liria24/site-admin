import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { drizzle } from 'drizzle-orm/node-sqlite'
import {
    authRelations,
    resolveDrizzleDatabases,
    type SiteAdminDatabaseResolver,
    type SiteAdminDatabaseResolverOptions,
    type SiteAdminResolvedDatabases,
} from './database'

/** Opens one module-owned SQLite connection. Migrations must be applied by the application. */
export const createSQLiteDatabaseResolver = (
    options: SiteAdminDatabaseResolverOptions & { filename: string },
): SiteAdminDatabaseResolver => {
    let connection: ReturnType<typeof drizzle> | undefined
    let pending: Promise<SiteAdminResolvedDatabases> | undefined
    let closed = false
    return {
        resolve() {
            if (closed) return Promise.reject(new Error('[site-admin] SQLite database resolver is closed.'))
            if (pending) return pending
            pending = (async () => {
                if (options.filename !== ':memory:') await mkdir(dirname(options.filename), { recursive: true })
                if (closed) throw new Error('[site-admin] SQLite database resolver is closed.')
                connection = drizzle(options.filename, { relations: authRelations(options.schema) })
                try {
                    return resolveDrizzleDatabases(connection, options)
                } catch (error) {
                    connection.$client.close()
                    connection = undefined
                    throw error
                }
            })()
            pending.catch(() => {
                pending = undefined
            })
            return pending
        },
        close() {
            closed = true
            connection?.$client.close()
            connection = undefined
        },
    }
}
