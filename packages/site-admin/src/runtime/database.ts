import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import type { BetterAuthOptions } from 'better-auth'
import type { AnyRelations } from 'drizzle-orm'
import { drizzleAdapter } from '../adapters/drizzle'
import type { SiteAdminDatabase } from '../adapter'
import { SiteAdminError } from '../errors'

export type SiteAdminDatabaseConfig =
    | { connector: 'sqlite'; schema: string; filename?: string; authUsePlural?: boolean }
    | { connector: 'd1'; schema: string; binding: string; authUsePlural?: boolean }

export interface SiteAdminResolvedDatabases {
    database: SiteAdminDatabase
    authDatabase?: BetterAuthOptions['database']
}

export interface SiteAdminDatabaseResolver {
    resolve(context?: object): Promise<SiteAdminResolvedDatabases>
    /** Close only connections opened by the module, never application-owned bindings. */
    close(): void
}

export interface SiteAdminDatabaseResolverOptions {
    schema: Record<string, unknown>
    auth?: boolean
    authUsePlural?: boolean
}

/** Finalize the advanced hook result without mixing adapters from different connections. */
export const finalizeSiteAdminDatabases = async <Context extends Partial<SiteAdminResolvedDatabases>>(
    context: Context,
    resolver?: SiteAdminDatabaseResolver,
    options: { platformContext?: object; requireAuth?: boolean } = {},
): Promise<Context & SiteAdminResolvedDatabases> => {
    if (!context.database && context.authDatabase)
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            '[site-admin] A site-admin:database hook that provides authDatabase must also provide database.',
        )
    if (!context.database && resolver) Object.assign(context, await resolver.resolve(options.platformContext))
    if (!context.database)
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            '[site-admin] Configure a SQLite/D1 database or provide an adapter through the site-admin:database hook.',
        )
    if (options.requireAuth && !context.authDatabase)
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            '[site-admin] The site-admin:database hook must provide authDatabase from the same connection when authentication is enabled.',
        )
    return context as Context & SiteAdminResolvedDatabases
}

/** Generated Better Auth relations belong to the application's combined schema. */
export const authRelations = (schema: Record<string, unknown>): AnyRelations =>
    (schema.authRelations ?? {}) as AnyRelations

export const resolveDrizzleDatabases = (
    database: Parameters<typeof drizzleAdapter>[0],
    options: SiteAdminDatabaseResolverOptions,
): SiteAdminResolvedDatabases => ({
    database: drizzleAdapter(database, { schema: options.schema }),
    ...(options.auth
        ? {
              authDatabase: authAdapter(database, {
                  provider: 'sqlite',
                  schema: options.schema,
                  transaction: false,
                  usePlural: options.authUsePlural ?? false,
              }),
          }
        : {}),
})
