import { eventHandler, sendWebResponse, toWebRequest } from 'h3'

import { handleManagementRequest } from '../server/http'
import { useSiteAdminRuntime } from '../server/runtime'

export default eventHandler(async (event) => {
    const runtime = useSiteAdminRuntime()
    return sendWebResponse(
        event,
        await handleManagementRequest(runtime.siteAdmin, toWebRequest(event), runtime.managementBase),
    )
})
