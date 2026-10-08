import { drizzle } from 'drizzle-orm/node-sqlite'
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'
import type { SiteAdminDatabase } from '@liria24/site-admin/adapter'
// @ts-ignore The consumer test generates its application-owned schema before building.
import * as schema from '../.data/schema/schema'

let database: ReturnType<typeof drizzle> | undefined
let siteAdminDatabase: SiteAdminDatabase | undefined

/** The application chooses its driver, connection, generated schema, and lifetime. */
export const getAppDb = () =>
    (database ??= drizzle(process.env.SITE_ADMIN_TEST_DATABASE ?? './.data/content.sqlite3', {
        relations: schema.authRelations,
    }))

export const getSiteAdminDatabase = (): SiteAdminDatabase =>
    (siteAdminDatabase ??= drizzleAdapter(getAppDb(), { schema }))
