import { isNuxtError, type RequestEvent } from 'nuxt/server'
import type { BetterAuthOptions } from 'better-auth'
import { SiteAdminError } from '../errors'
import type { SiteAdmin } from '../server/site-admin'
import type { SiteAdminTaskOptions } from '../runtime/tasks'

export interface SiteAdminRuntime {
    development?: {
        connector: string
        devDatabase: boolean
        locales?: { defaultLocale?: string; strategy: string; supported: string[] }
    }
    managementBase: string
    publicBase: string
    tasks?: SiteAdminTaskOptions
    getSiteAdmin: (
        event?: RequestEvent,
        platformContext?: object,
    ) => SiteAdmin<RequestEvent> | Promise<SiteAdmin<RequestEvent>>
    initializeRequest?: (event: RequestEvent) => void | Promise<void>
    authDatabase?: (context?: object) => BetterAuthOptions['database']
}

let runtime: SiteAdminRuntime | undefined

export const configureSiteAdminRuntime = (value: SiteAdminRuntime): SiteAdminRuntime => {
    runtime = value
    return value
}

export const useSiteAdminRuntime = (): SiteAdminRuntime => {
    if (!runtime) {
        throw new SiteAdminError('SITE_ADMIN_MIGRATION_REQUIRED', 'Site Admin runtime has not been initialized.')
    }
    return runtime
}

/** Background database tasks may omit the event and pass native platform context for bindings.
 * This context resolves the database only; AI operations receive their own explicit context.
 */
export const useSiteAdmin = async (event?: RequestEvent, platformContext?: object): Promise<SiteAdmin<RequestEvent>> =>
    useSiteAdminRuntime().getSiteAdmin(event, platformContext)

/** Normalize intentional authorization refusals before the framework-neutral HTTP error boundary. */
export const normalizeSiteAdminAuthorizationError = (error: unknown): unknown => {
    if (isNuxtError(error)) {
        if (error.status === 401) return new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'Authentication is required.')
        if (error.status === 403) return new SiteAdminError('SITE_ADMIN_FORBIDDEN', 'Authorization denied.')
    }
    return error
}
