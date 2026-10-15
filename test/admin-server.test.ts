import { expect, it, vi } from 'vitest'
import type { RequestEvent } from 'nuxt/server'
import { useAdmin } from '../packages/site-admin/src/server-api'
import { configureSiteAdminRuntime } from '../packages/site-admin/src/nuxt/server'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { createSiteAdmin } from '../packages/site-admin/src/server'
import { createMemoryDatabase } from './memory-storage'
import { createManagementOperations } from '../packages/site-admin/src/server/operations'
import { createAdminClient } from '../packages/site-admin/src/admin-client'

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

it('uses direct model-bound operations with one target read and redacts write-only results', async () => {
    let roles = ['operator']
    const admin = createSiteAdmin({
        config: defineSiteAdminConfig({
            authorization: { roles: { operator: { models: { posts: ['create', 'update', 'publish'] } } } },
            models: { posts: { fields: { title: text({ i18n: true }) } }, private: { fields: { title: text() } } },
        }),
        database: createMemoryDatabase(),
        locales: { defaultLocale: 'ja', supported: ['ja', 'en'] },
        authorize: () => ({ id: 'operator', roles }),
    })
    configureSiteAdminRuntime({ managementBase: '/manage', publicBase: '/content', getSiteAdmin: () => admin })
    const event = { req: new Request('https://site.test/action') } as RequestEvent
    const client = useAdmin(event)
    let receipt = await client.entries.create('posts', {
        data: { title: 'secret' },
        translations: { en: { title: 'Secret' } },
    })
    expect(receipt).not.toHaveProperty('data')
    const read = vi.spyOn(admin, 'getEntry')
    receipt = await client.entries.update('posts', receipt, { translations: { en: { title: 'Changed' } } })
    // One target read, then the committed result is loaded once.
    expect(read).toHaveBeenCalledTimes(2)
    expect(receipt).not.toHaveProperty('translations')
    await expect(client.entries.update('private', receipt, { data: { secret: 'wrong model' } })).rejects.toMatchObject({
        code: 'SITE_ADMIN_ENTRY_NOT_FOUND',
    })
    await expect(useAdmin().entries.get('posts', receipt.id)).rejects.toMatchObject({
        code: 'SITE_ADMIN_AUTH_REQUIRED',
    })
    roles = ['admin']
    expect(await useAdmin(event).entries.get('posts', receipt.id)).toMatchObject({
        data: { title: 'secret' },
        translations: { en: { title: 'Changed' } },
    })
    vi.restoreAllMocks()
})

it('loads definitions once for a list and fetches an imperative update target only once', async () => {
    const admin = createSiteAdmin({
        config: defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } }),
        database: createMemoryDatabase(),
        authorize: () => ({ id: 'admin', roles: ['admin'] }),
    })
    const raw = createManagementOperations(() => admin, new Request('https://site.test/action'))
    const models = vi.spyOn(raw, 'models')
    const get = vi.spyOn(raw, 'getEntry')
    const client = createAdminClient(raw)
    const created = await client.entries.create('posts', { data: { title: 'First' } })
    await client.entries.create('posts', { data: { title: 'Second' } })
    expect((await client.entries.list('posts')).items).toHaveLength(2)
    expect(models).toHaveBeenCalledTimes(1)
    await client.entries.update('posts', created, { data: { title: 'Updated' } })
    expect(get).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
})
