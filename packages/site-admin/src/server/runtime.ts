import { SiteAdminError } from '../errors'
import type { SiteAdmin } from './site-admin'

export interface SiteAdminRuntime {
    managementBase: string
    publicBase: string
    siteAdmin: SiteAdmin
}

let runtime: SiteAdminRuntime | undefined

export const configureSiteAdminRuntime = (value: SiteAdminRuntime): SiteAdminRuntime => {
    runtime = value
    return value
}

export const useSiteAdminRuntime = (): SiteAdminRuntime => {
    if (!runtime) {
        throw new SiteAdminError(
            'SITE_ADMIN_MIGRATION_REQUIRED',
            'Site Admin runtime has not been initialized.',
        )
    }
    return runtime
}

export const useSiteAdmin = (): SiteAdmin => useSiteAdminRuntime().siteAdmin
