import { eventHandler, sendWebResponse } from 'h3'

import { useSiteAdmin } from '../server/runtime'

export default eventHandler(async (event) =>
    sendWebResponse(
        event,
        Response.json(await useSiteAdmin().inspect(), {
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        }),
    ),
)
