import type { SiteAdminAuthorizeContext } from '@liria24/site-admin/nuxt'
import { createError, useServerHooks } from 'nuxt/server'

export default () => {
    useServerHooks().hook('site-admin:authorize', (context: SiteAdminAuthorizeContext) => {
        if (context.event.req.headers.get('x-site-admin-test-deny')) {
            throw createError({ status: 403, statusText: 'Forbidden', message: 'PRIVATE_DENIAL_DETAIL' })
        }
        const role = context.event.req.headers.get('x-site-admin-test-role')
        if (context.actor && (role === 'admin' || role === 'editor')) context.actor.roles = [role]
    })
}
