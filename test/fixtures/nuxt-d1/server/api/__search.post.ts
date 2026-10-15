import { defineEventHandler } from 'nuxt/server'
import { createSiteAdmin, handleManagementRequest } from '@liria24/site-admin/internal/server'
import config from '../../site-admin.config'
import { useVoidDatabase } from '@liria24/site-admin/internal/runtime/database'
import { withSiteAdminContext } from '@liria24/site-admin/internal/runtime/context'
import * as schema from '../../db/schema'

export default defineEventHandler((event) =>
    withSiteAdminContext(event.context, async () => {
        const core = createSiteAdmin({
            config,
            database: useVoidDatabase(schema),
            authorize: () => ({ id: 'synthetic-search-reader', roles: ['admin'] }),
        })
        const entry = await core.createEntry('posts', {
            data: { title: 'ΣΟΣ '.repeat(250), slug: 'synthetic-unicode-search' },
        })
        const started = performance.now()
        const response = await handleManagementRequest(
            core,
            new Request(
                'https://synthetic.test/manage/entries?model=posts&q=' + encodeURIComponent('σος') + '&limit=1',
            ),
            '/manage',
        )
        const result = { status: response.status, data: await response.json(), elapsed: performance.now() - started }
        await core.deleteEntry(entry.id, { expectedVersion: entry.version })
        return result
    }),
)
