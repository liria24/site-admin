export interface SiteAdminIssue {
    message: string
    path: string
}

export type SiteAdminErrorCode =
    | 'SITE_ADMIN_ASSET_IN_USE'
    | 'SITE_ADMIN_ASSET_NOT_READY'
    | 'SITE_ADMIN_AUTH_REQUIRED'
    | 'SITE_ADMIN_CONFLICT'
    | 'SITE_ADMIN_DATABASE_UNSUPPORTED'
    | 'SITE_ADMIN_ENTRY_NOT_FOUND'
    | 'SITE_ADMIN_INVALID_INPUT'
    | 'SITE_ADMIN_MIGRATION_REQUIRED'
    | 'SITE_ADMIN_MODEL_NOT_FOUND'
    | 'SITE_ADMIN_NOT_PUBLIC'
    | 'SITE_ADMIN_RELATION_BLOCKED'
    | 'SITE_ADMIN_ROUTE_CONFLICT'
    | 'SITE_ADMIN_SCHEMA_INCOMPATIBLE'
    | 'SITE_ADMIN_STORAGE_UNAVAILABLE'

const statuses: Record<SiteAdminErrorCode, number> = {
    SITE_ADMIN_ASSET_IN_USE: 409,
    SITE_ADMIN_ASSET_NOT_READY: 409,
    SITE_ADMIN_AUTH_REQUIRED: 401,
    SITE_ADMIN_CONFLICT: 409,
    SITE_ADMIN_DATABASE_UNSUPPORTED: 500,
    SITE_ADMIN_ENTRY_NOT_FOUND: 404,
    SITE_ADMIN_INVALID_INPUT: 400,
    SITE_ADMIN_MIGRATION_REQUIRED: 503,
    SITE_ADMIN_MODEL_NOT_FOUND: 404,
    SITE_ADMIN_NOT_PUBLIC: 404,
    SITE_ADMIN_RELATION_BLOCKED: 409,
    SITE_ADMIN_ROUTE_CONFLICT: 409,
    SITE_ADMIN_SCHEMA_INCOMPATIBLE: 503,
    SITE_ADMIN_STORAGE_UNAVAILABLE: 503,
}

export class SiteAdminError extends Error {
    readonly code: SiteAdminErrorCode
    readonly issues?: SiteAdminIssue[]
    readonly status: number

    constructor(code: SiteAdminErrorCode, message: string, issues?: SiteAdminIssue[]) {
        super(message)
        this.name = 'SiteAdminError'
        this.code = code
        this.status = statuses[code]
        if (issues) this.issues = issues
    }
}
