import { isNuxtError, type RequestEvent } from 'nuxt/server'
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
    runAiAction?: (event: RequestEvent, name: string, input: unknown) => Promise<unknown>
    presentation?: (
        event: RequestEvent,
        path: string,
    ) => Promise<ReturnType<typeof import('../runtime/presentation').resolvePublicPresentation>>
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

/** Normalize intentional authorization refusals before the framework-neutral HTTP error boundary. */
export const normalizeSiteAdminAuthorizationError = (error: unknown): unknown => {
    if (isNuxtError(error)) {
        if (error.status === 401) return new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'Authentication is required.')
        if (error.status === 403) return new SiteAdminError('SITE_ADMIN_FORBIDDEN', 'Authorization denied.')
    }
    return error
}
