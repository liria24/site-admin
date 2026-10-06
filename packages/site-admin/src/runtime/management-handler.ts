import { defineEventHandler } from 'nuxt/server'
import { handleManagementRequest } from '../server/http'
import { useSiteAdminRuntime } from '../nuxt/server'

export default defineEventHandler(async (event) => {
    const runtime = useSiteAdminRuntime()
    return handleManagementRequest(await runtime.getSiteAdmin(event), event.req, runtime.managementBase, event)
})
