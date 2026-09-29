import { Readable } from 'node:stream'
import { eventHandler, sendWebResponse, toWebRequest, getRequestURL } from 'h3'

import { handleManagementRequest } from '../server/http'
import { useSiteAdminRuntime } from '../server/runtime'

export default eventHandler(async (event) => {
    const runtime = useSiteAdminRuntime()
    // H3 1.x's Node bridge eagerly drains requests; preserve backpressure for raw uploads.
    const raw = event.node.req as typeof event.node.req & { body?: unknown }
    const hasBody = !['GET', 'HEAD'].includes(event.method)
    const body =
        raw.body instanceof ReadableStream
            ? raw.body
            : hasBody && !('__unenv__' in raw)
              ? (Readable.toWeb(raw) as ReadableStream<Uint8Array>)
              : undefined
    const request = body
        ? new Request(getRequestURL(event), {
              method: event.method,
              headers: event.headers,
              body,
              duplex: 'half',
          } as RequestInit)
        : toWebRequest(event)
    return sendWebResponse(
        event,
        await handleManagementRequest(await runtime.getSiteAdmin(event), request, runtime.managementBase, event),
    )
})
