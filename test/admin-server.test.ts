import { expect, it, vi } from 'vitest'
import type { RequestEvent } from 'nuxt/server'
import { useAdmin } from '../packages/site-admin/src/server-api'
import { configureSiteAdminRuntime } from '../packages/site-admin/src/nuxt/server'

it('runs event-bound AI without resolving content storage or an entry', async () => {
    const getSiteAdmin = vi.fn(() => {
        throw new Error('Content database must stay unopened')
    })
    const runAiAction = vi.fn(async () => ({ text: 'Prepared' }))
    configureSiteAdminRuntime({ managementBase: '/manage', publicBase: '/content', getSiteAdmin, runAiAction })
    const event = { req: new Request('https://site.test/action') } as RequestEvent
    expect(await useAdmin(event).ai.run('prepare', { text: 'Input' })).toEqual({ text: 'Prepared' })
    expect(runAiAction).toHaveBeenCalledWith(event, 'prepare', { input: { text: 'Input' } })
    expect(getSiteAdmin).not.toHaveBeenCalled()
    await expect(useAdmin().ai.run('prepare', {})).rejects.toMatchObject({ code: 'SITE_ADMIN_AUTH_REQUIRED' })
})
