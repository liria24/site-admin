import { defineEventHandler } from 'nuxt/server'
import { handlePublicRequest } from '../server/http'
import { useSiteAdminRuntime } from '../nuxt/server'
import { withSiteAdminContext } from './context'

export default defineEventHandler(async (event) => {
    const runtime = useSiteAdminRuntime()
    return withSiteAdminContext(event.context, async () =>
        handlePublicRequest(await runtime.getSiteAdmin(event), event.req, runtime.publicBase),
    )
})
