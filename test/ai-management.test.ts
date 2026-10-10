import { describe, expect, it, vi } from 'vitest'
import { createSiteAdmin, handleManagementRequest } from '../packages/site-admin/src/server'
import { createMemoryDatabase } from './memory-storage'

describe('retired AI callback endpoints', () => {
    it.each(['models/posts/ai/metadata', 'models/posts/ai/proofread', 'entries/entry/ai/publication'])(
        'rejects %s without touching content storage',
        async (path) => {
            const database = createMemoryDatabase()
            const assertSchema = vi.spyOn(database.storage, 'assertSchema')
            const commit = vi.spyOn(database.storage, 'commit')
            const admin = createSiteAdmin({
                config: { models: { posts: { fields: {} } } },
                database,
                authorize: () => ({ id: 'admin', roles: ['admin'] }),
            })
            const response = await handleManagementRequest(
                admin,
                new Request('https://site.test/api/site-admin/' + path, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                }),
            )
            expect(response.status).toBe(404)
            expect(assertSchema).not.toHaveBeenCalled()
            expect(commit).not.toHaveBeenCalled()
            expect(admin).not.toHaveProperty('runAIAction')
            expect(admin.descriptor.models.posts).not.toHaveProperty('ai')
        },
    )
})
