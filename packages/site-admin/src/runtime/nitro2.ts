import { Readable } from 'node:stream'
import { getRequestURL, type H3Event } from 'h3'
import type { RequestEvent } from 'nuxt/server'

// Only Better Auth 0.3.x and Nitro 2's input bridge need the actual backend event.
const events = new WeakMap<object, H3Event>()

/** Nitro 2's Cloudflare bridge otherwise buffers before the H3 request hook. */
export const transformNitroCloudflareRequest = (code: string, id: string) => {
    if (!id.replaceAll('\\', '/').endsWith('/cloudflare/runtime/_module-handler.mjs')) return
    const buffered = 'body = Buffer.from(await request.arrayBuffer());'
    return { code: code.replace(buffered, 'body = request.body;'.padEnd(buffered.length)), map: null }
}

export const captureNitroRequest = (event: H3Event, managementBase: string, streamUploads: boolean): void => {
    events.set(event.context, event)
    if (event.web?.request || ['GET', 'HEAD'].includes(event.method)) return
    const raw = event.node.req as typeof event.node.req & { body?: unknown }
    const upload =
        streamUploads &&
        event.method === 'POST' &&
        event.path
            .split('?')[0]!
            .replace(/\/$/u, '')
            .endsWith(managementBase + '/assets')
    // Cloudflare's raw stream must be shared by every native wrapper, including JSON routes.
    // Otherwise a header-reading middleware starts a second uncached H3 read of the same stream.
    const body =
        raw.body instanceof ReadableStream
            ? raw.body
            : upload && !('__unenv__' in raw)
              ? (Readable.toWeb(raw) as ReadableStream<Uint8Array>)
              : undefined
    if (!body) return
    // H3 exposes a Web request bridge; Nuxt 4.6 respects it instead of buffering readRawBody.
    // Install it before native middleware can access event.req (even just its headers).
    event.web = {
        ...event.web,
        request: new Request(getRequestURL(event), {
            method: event.method,
            headers: event.headers,
            body,
            duplex: 'half',
        } as RequestInit),
    }
}

export const getNitroRequest = (event: RequestEvent): H3Event => {
    const backend = events.get(event.context)
    if (!backend) throw new Error('[site-admin] Better Auth requires the configured Nitro 2 request adapter.')
    return backend
}
