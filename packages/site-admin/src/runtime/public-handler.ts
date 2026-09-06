import { eventHandler, sendWebResponse, toWebRequest } from 'h3'

import { handlePublicRequest } from '../server/http'
import { useSiteAdminRuntime } from '../server/runtime'

export default eventHandler(async (event) => {
    const runtime = useSiteAdminRuntime()
    return sendWebResponse(
        event,
        await handlePublicRequest(runtime.siteAdmin, toWebRequest(event), runtime.publicBase),
    )
})
