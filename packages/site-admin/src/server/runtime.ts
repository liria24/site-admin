import { SiteAdminError } from '../errors'
import type { SiteAdmin } from './site-admin'

export interface SiteAdminRuntime {
    development?: {
        connector: string
        devDatabase: boolean
        locales?: { defaultLocale?: string; strategy: string; supported: string[] }
    }
    managementBase: string
    publicBase: string
    getSiteAdmin: (event?: unknown) => SiteAdmin | Promise<SiteAdmin>
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

export const useSiteAdmin = async (event?: unknown): Promise<SiteAdmin> => useSiteAdminRuntime().getSiteAdmin(event)
