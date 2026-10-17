import type { SiteAdminEntry, SiteAdminRevision, SiteAdminFormModels, SiteAdminPublicModels } from './client'
export type Entry<Name extends string = string> = SiteAdminEntry<
    Name extends keyof SiteAdminFormModels ? SiteAdminFormModels[Name] : Record<string, unknown>
>
export type Revision<Name extends string = string> = SiteAdminRevision<
    Name extends keyof SiteAdminFormModels ? SiteAdminFormModels[Name] : Record<string, unknown>
>
export type Content<Name extends keyof SiteAdminPublicModels = keyof SiteAdminPublicModels> =
    SiteAdminPublicModels[Name]
export type { SiteAdminAsset as Asset } from './management-assets'
