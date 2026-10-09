import { defineEventHandler } from 'nuxt/server'
import { handleAiActionRequest } from '../server/ai-actions-http'
import { useSiteAdminRuntime } from '../nuxt/server'
import { SiteAdminError } from '../errors'

export default defineEventHandler((event) => {
    const runtime = useSiteAdminRuntime()
    return handleAiActionRequest(event.req, runtime.managementBase, (name, input) => {
        if (!runtime.runAiAction) throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'AI actions are unavailable.')
        return runtime.runAiAction(event, name, input)
    })
})
