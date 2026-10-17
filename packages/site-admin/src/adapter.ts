import type { SiteAdminConfig } from './config'
import type { StorageAssets, StorageContent } from './storage'
export type * from './storage'

/** Configuration-bound domain storage; schema validation never runs DDL. */
export interface SiteAdminStorage extends StorageContent, StorageAssets {
    assertSchema(): Promise<void>
}

/** Storage boundary for the domain; Void owns the native connection and migrations. */
export interface SiteAdminDatabase {
    bind(config: SiteAdminConfig): SiteAdminStorage
}
