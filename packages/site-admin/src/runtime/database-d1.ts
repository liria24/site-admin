import { drizzle, type AnyD1Database } from 'drizzle-orm/d1'
import { SiteAdminError } from '../errors'
import {
    authRelations,
    resolveDrizzleDatabases,
    type SiteAdminDatabaseResolver,
    type SiteAdminDatabaseResolverOptions,
    type SiteAdminResolvedDatabases,
} from './database'

const bindingFromContext = (context: object | undefined, name: string): unknown => {
    const cloudflare = context && 'cloudflare' in context ? context.cloudflare : undefined
    const env = cloudflare && typeof cloudflare === 'object' && 'env' in cloudflare ? cloudflare.env : undefined
    return env && typeof env === 'object' ? (env as Record<string, unknown>)[name] : undefined
}

/** Uses the current request/task binding, with no global environment fallback or remote access. */
export const createD1DatabaseResolver = (
    options: SiteAdminDatabaseResolverOptions & { binding: string },
): SiteAdminDatabaseResolver => {
    let databases = new WeakMap<object, SiteAdminResolvedDatabases>()
    return {
        resolve(context) {
            const binding = bindingFromContext(context, options.binding)
            if (
                !binding ||
                typeof binding !== 'object' ||
                !('prepare' in binding) ||
                typeof binding.prepare !== 'function' ||
                !('batch' in binding) ||
                typeof binding.batch !== 'function'
            )
                return Promise.reject(
                    new SiteAdminError(
                        'SITE_ADMIN_DATABASE_UNSUPPORTED',
                        `[site-admin] D1 binding "${options.binding}" is missing from the current request or task context.`,
                    ),
                )
            let resolved = databases.get(binding)
            if (!resolved) {
                const database = drizzle(binding as AnyD1Database, { relations: authRelations(options.schema) })
                resolved = resolveDrizzleDatabases(database, options)
                databases.set(binding, resolved)
            }
            return Promise.resolve(resolved)
        },
        close() {
            databases = new WeakMap()
        },
    }
}
