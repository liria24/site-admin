import { defineEventHandler, getQuery } from 'nuxt/server'
import { useSiteAdminRuntime } from '@liria24/site-admin/internal/nuxt/server'
import { withSiteAdminContext } from '@liria24/site-admin/internal/runtime/context'

export default defineEventHandler((event) =>
    withSiteAdminContext(event.context, async () => {
        const site = await useSiteAdminRuntime().getSiteAdmin(event)
        const kind = getQuery(event).kind === 'scheduled' ? 'scheduled' : 'manual'
        const entry = await site.createEntry('posts', { data: { title: `D1 ${kind} runtime`, slug: kind } })
        const scheduled = await site.schedulePublish(entry.id, {
            expectedVersion: entry.version,
            at: new Date(Date.now() + 500),
        })
        return { id: entry.id, scheduledAt: scheduled.scheduledAt }
    }),
)
