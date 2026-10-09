import type { SiteAdminDatabase } from '../adapter'
import { SiteAdminError } from '../errors'

/** Structural native request shape, without a dependency on Nuxt or an ORM. */
export interface SiteAdminDatabaseRequestEvent {
    req: Request
    context: Record<string, unknown>
}

export interface SiteAdminDatabaseContext {
    request?: Request
    event?: SiteAdminDatabaseRequestEvent
    /** Explicit native task/platform context for work without an HTTP request. */
    platformContext?: object
}

/** Applications own connections, drivers, schema, migrations, caching, and disposal. */
export type SiteAdminDatabaseConfig =
    | SiteAdminDatabase
    | ((context: SiteAdminDatabaseContext) => SiteAdminDatabase | Promise<SiteAdminDatabase>)

/** Invoke the application adapter only; never open, close, or migrate its database. */
export const resolveSiteAdminDatabase = async (
    config: SiteAdminDatabaseConfig | undefined,
    context: SiteAdminDatabaseContext = {},
): Promise<SiteAdminDatabase> => {
    const database = typeof config === 'function' ? await config(context) : config
    if (
        !database ||
        database.dialect !== 'sqlite' ||
        typeof database.query !== 'function' ||
        typeof database.atomic !== 'function' ||
        typeof database.bind !== 'function'
    )
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            '[site-admin] Provide an application-owned SiteAdminDatabase adapter in database or the site-admin:database hook.',
        )
    return database
}
