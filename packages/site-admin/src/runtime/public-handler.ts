import { defineEventHandler } from 'nuxt/server'
import { handlePublicRequest } from '../server/http'
import { useSiteAdminRuntime } from '../nuxt/server'

export default defineEventHandler(async (event) => {
    const runtime = useSiteAdminRuntime()
    return handlePublicRequest(await runtime.getSiteAdmin(event), event.req, runtime.publicBase)
})
