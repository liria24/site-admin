import type { SiteAdminDatabase } from '../adapter'
import type { BetterAuthOptions } from 'better-auth'
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
    if (!database || typeof database.bind !== 'function')
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            '[site-admin] Provide an application-owned SiteAdminDatabase adapter in database or the site-admin:database hook.',
        )
    return database
}

/** Request-local hook state is shared by native auth preparation and lazy CMS resolution. */
export interface SiteAdminDatabaseScopeContext<
    Event extends SiteAdminDatabaseRequestEvent = SiteAdminDatabaseRequestEvent,
> extends SiteAdminDatabaseContext {
    event?: Event
    database?: SiteAdminDatabase
    authDatabase?: BetterAuthOptions['database']
}

export const createSiteAdminDatabaseScope = <Event extends SiteAdminDatabaseRequestEvent>(
    config: SiteAdminDatabaseConfig | undefined,
    hook: (context: SiteAdminDatabaseScopeContext<Event>) => void | Promise<void>,
) => {
    type Context = SiteAdminDatabaseScopeContext<Event>
    const contexts = new WeakMap<object, Context>()
    const preparing = new WeakMap<object, Promise<Context>>()
    const resolving = new WeakMap<object, Promise<Context & { database: SiteAdminDatabase }>>()
    const prepare = (event?: Event, platformContext?: object): Promise<Context> => {
        const key = event?.context
        const cached = key && preparing.get(key)
        if (cached) return cached
        const context: Context = {
            ...(event ? { event, request: event.req } : {}),
            ...(platformContext ? { platformContext } : {}),
        }
        const result = Promise.resolve().then(async () => {
            await hook(context)
            if (key) contexts.set(key, context)
            return context
        })
        if (key) {
            preparing.set(key, result)
            void result.catch(() => preparing.delete(key))
        }
        return result
    }
    const resolve = (event?: Event, platformContext?: object): Promise<Context & { database: SiteAdminDatabase }> => {
        const key = event?.context
        const cached = key && resolving.get(key)
        if (cached) return cached
        const result = prepare(event, platformContext).then(async (context) => {
            const database = await resolveSiteAdminDatabase(context.database ?? config, {
                ...(event ? { event, request: event.req, platformContext: event.context } : {}),
                ...(platformContext ? { platformContext } : {}),
            })
            return Object.assign(context, { database })
        })
        if (key) {
            resolving.set(key, result)
            // A CMS failure must not discard an already prepared native auth provider.
            void result.catch(() => resolving.delete(key))
        }
        return result
    }
    return { prepare, resolve, get: (context: object) => contexts.get(context) }
}
