import { defineEventHandler } from 'nuxt/server'
import { useSiteAdminRuntime } from '../nuxt/server'
import { withSiteAdminContext } from './context'
import { SiteAdminError } from '../errors'

export default defineEventHandler((event) =>
    withSiteAdminContext(event.context, async () => {
        if (event.req.method !== 'GET' && event.req.method !== 'HEAD') return new Response(null, { status: 405 })
        const path = new URL(event.req.url).searchParams.get('path') ?? '/'
        if (!path.startsWith('/') || path.startsWith('//')) return new Response(null, { status: 400 })
        try {
            const value = await useSiteAdminRuntime().presentation?.(
                event,
                new URL(path, 'http://site-admin.local').pathname,
            )
            return Response.json(value ?? {}, { headers: { 'cache-control': 'private, no-store' } })
        } catch (error) {
            if (error instanceof SiteAdminError && error.code === 'SITE_ADMIN_INVALID_INPUT')
                return Response.json(
                    { error: { code: error.code, message: error.message } },
                    { status: error.status, headers: { 'cache-control': 'private, no-store' } },
                )
            throw error
        }
    }),
)
