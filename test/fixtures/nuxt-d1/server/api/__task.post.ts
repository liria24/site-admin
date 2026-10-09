import { defineEventHandler, getQuery } from 'nuxt/server'
import { runTask } from 'nitropack/runtime'

export default defineEventHandler(async (event) => {
    const name = getQuery(event).task === 'gc' ? 'site-admin:asset-gc' : 'site-admin:publish-due'
    return (await runTask(name, { context: event.context })).result
})
