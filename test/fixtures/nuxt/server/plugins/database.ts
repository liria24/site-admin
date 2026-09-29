import { drizzle } from 'drizzle-orm/node-sqlite'
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'
import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { defineNitroPlugin } from 'nitropack/runtime'
// @ts-ignore Test setup generates this application-owned schema before building.
import * as schema from '../../.data/schema/schema'

export default defineNitroPlugin((app) => {
    let adapters: { auth: ReturnType<typeof authAdapter>; siteAdmin: ReturnType<typeof drizzleAdapter> } | undefined
    app.hooks.hook('site-admin:database', (context) => {
        if (!adapters) {
            const database = drizzle(process.env.SITE_ADMIN_TEST_DATABASE!, {
                relations: (schema as typeof schema & { authRelations: never }).authRelations,
            })
            adapters = {
                auth: authAdapter(database, { provider: 'sqlite', schema, transaction: false }),
                siteAdmin: drizzleAdapter(database, { schema }),
            }
        }
        context.authDatabase = adapters.auth
        context.database = adapters.siteAdmin
    })
})
