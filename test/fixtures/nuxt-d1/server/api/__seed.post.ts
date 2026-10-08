import { defineEventHandler, getQuery } from 'nuxt/server'
import { useSiteAdmin } from '@liria24/site-admin/nuxt/server'

export default defineEventHandler(async (event) => {
    const site = await useSiteAdmin(event)
    const kind = getQuery(event).kind === 'scheduled' ? 'scheduled' : 'manual'
    const entry = await site.createEntry('posts', {
        slug: kind,
        data: { title: `D1 ${kind} runtime` },
    })
    const scheduled = await site.schedulePublish(entry.id, {
        expectedVersion: entry.version,
        at: new Date(Date.now() + 500),
    })
    return { id: entry.id, scheduledAt: scheduled.scheduledAt }
})
