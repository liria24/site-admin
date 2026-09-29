import type { SiteAdminDatabase } from '../adapter'
import type { SiteAdminConfig } from '../config'

export const assertSiteAdminSchema = (database: SiteAdminDatabase, config: SiteAdminConfig): Promise<void> =>
    database.bind(config).assertSchema()
