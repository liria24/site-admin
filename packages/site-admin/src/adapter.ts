import type { SiteAdminConfig } from './config'
import type { StorageAssets, StorageContent } from './storage'
export type * from './storage'

/** Configuration-bound domain storage; schema validation never runs DDL. */
export interface SiteAdminStorage extends StorageContent, StorageAssets {
    assertSchema(): Promise<void>
}

/** Applications own connections, migrations and lifecycle. Core has no SQL or ORM dependency. */
export interface SiteAdminDatabase {
    bind(config: SiteAdminConfig): SiteAdminStorage
}
