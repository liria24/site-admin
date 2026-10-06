import { drizzle } from 'drizzle-orm/node-sqlite'
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'
import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { useServerHooks } from 'nuxt/server'
// @ts-ignore Test setup generates this application-owned schema before building.
import * as schema from '../../.data/schema/schema'

export default () => {
    let adapters: { auth: ReturnType<typeof authAdapter>; siteAdmin: ReturnType<typeof drizzleAdapter> } | undefined
    useServerHooks().hook('site-admin:database', (context) => {
        if (context.event) {
            if (context.event.context.siteAdminDatabaseReady)
                throw new Error('Database hook ran twice for one request.')
            context.event.context.siteAdminDatabaseReady = true
            void context.event.req.headers.get('x-site-admin-test-role')
        }
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
}
