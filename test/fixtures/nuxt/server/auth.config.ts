import { defineServerAuth } from '@nuxtjs/better-auth/config'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { admin } from 'better-auth/plugins'
import { getAppDb } from './database'
// @ts-ignore The consumer test generates its application-owned schema before building.
import * as schema from '../.data/schema/schema'

export default defineServerAuth(({ requestOrigin }) => ({
    // Build/schema inspection has no request origin and must not open a connection.
    database: drizzleAdapter(requestOrigin ? getAppDb() : {}, { provider: 'sqlite', schema, transaction: false }),
    emailAndPassword: { enabled: true },
    plugins: [admin({ schema: { user: { fields: { role: 'accessRole' } } } })],
    session: { cookieCache: { enabled: true, maxAge: 300, strategy: 'jwe' } },
}))
