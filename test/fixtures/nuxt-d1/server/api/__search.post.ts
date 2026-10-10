import { defineEventHandler } from 'nuxt/server'
import { createSiteAdmin, handleManagementRequest } from '@liria24/site-admin/server'
import config from '../../site-admin.config'
import { getSiteAdminDatabase } from '../database'

export default defineEventHandler(async (event) => {
    const core = createSiteAdmin({
        config,
        database: getSiteAdminDatabase({ event }),
        authorize: () => ({ id: 'synthetic-search-reader', roles: ['admin'] }),
    })
    const entry = await core.createEntry('posts', {
        slug: 'synthetic-unicode-search',
        data: { title: 'ΣΟΣ '.repeat(250) },
    })
    const started = performance.now()
    const response = await handleManagementRequest(
        core,
        new Request('https://synthetic.test/manage/entries?model=posts&q=' + encodeURIComponent('σος') + '&limit=1'),
        '/manage',
    )
    const result = { status: response.status, data: await response.json(), elapsed: performance.now() - started }
    await core.deleteEntry(entry.id, { expectedVersion: entry.version })
    return result
})
