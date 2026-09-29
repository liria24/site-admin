import type { SiteAdminAuthorizeContext } from '@liria24/site-admin/nuxt'
import { defineNitroPlugin } from 'nitropack/runtime'

export default defineNitroPlugin((nitroApp) => {
    nitroApp.hooks.hook('site-admin:authorize', (context: SiteAdminAuthorizeContext) => {
        const role = context.request.headers.get('x-site-admin-test-role')
        if (context.actor && (role === 'admin' || role === 'editor')) context.actor.roles = [role]
    })
})
