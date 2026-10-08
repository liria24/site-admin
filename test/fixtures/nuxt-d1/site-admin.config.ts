import { defineSiteAdminConfig, text } from '@liria24/site-admin'
import type { SiteAdminDatabaseContext } from '@liria24/site-admin/runtime/database'

export default defineSiteAdminConfig({
    database: async (context: SiteAdminDatabaseContext) =>
        (await import('./server/database')).getSiteAdminDatabase(context),
    models: { posts: { fields: { title: text({ required: true }) } } },
    tasks: { publishDue: '* * * * *', syncAssets: true },
})
