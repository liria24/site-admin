import { eventHandler, getRequestURL, sendWebResponse } from 'h3'

import { useSiteAdmin } from '../server/runtime'

export default eventHandler(async (event) =>
    sendWebResponse(
        event,
        new Response(await useSiteAdmin().llms(getRequestURL(event).pathname.endsWith('/llms-full.txt')), {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    ),
)
