import { defineEventHandler } from 'nuxt/server'
import { useSiteAdminRuntime } from '@liria24/site-admin/internal/nuxt/server'
import { withSiteAdminContext } from '@liria24/site-admin/internal/runtime/context'

export default defineEventHandler((event) =>
    withSiteAdminContext(event.context, async () => {
        const core = await useSiteAdminRuntime().getSiteAdmin(event)
        const entry = await core.createEntry('posts', {
            data: { title: 'ΣΟΣ '.repeat(250), slug: 'synthetic-unicode-search' },
        })
        const started = performance.now()
        const data = await core.pageEntries({ models: ['posts'], q: 'σος' }, { limit: 1, offset: 0 })
        const result = { data, elapsed: performance.now() - started }
        await core.deleteEntry(entry.id, { expectedVersion: entry.version })
        return result
    }),
)
