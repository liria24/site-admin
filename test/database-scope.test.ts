import { describe, expect, it, vi } from 'vitest'
import { createSiteAdminDatabaseScope } from '../packages/site-admin/src/runtime/database'
import { createMemoryDatabase } from './memory-storage'

const event = () => ({ req: new Request('https://example.test'), context: { cloudflare: { env: {} } } })

describe('request-local database scope', () => {
    it('prepares auth without resolving CMS and shares concurrent auth/CMS hook work', async () => {
        const database = createMemoryDatabase()
        const resolver = vi.fn(async () => database)
        const authDatabase = (() => ({})) as never
        let release!: () => void
        const barrier = new Promise<void>((resolve) => {
            release = resolve
        })
        const hook = vi.fn(async (context) => {
            await barrier
            context.authDatabase = authDatabase
        })
        const scope = createSiteAdminDatabaseScope(resolver, hook)
        const request = event()
        const auth = scope.prepare(request)
        const secondAuth = scope.prepare(request)
        expect(secondAuth).toBe(auth)
        expect(resolver).not.toHaveBeenCalled()
        const cms = scope.resolve(request)
        expect(scope.resolve(request)).toBe(cms)
        release()
        expect((await auth).authDatabase).toBe(authDatabase)
        expect((await cms).database).toBe(database)
        expect(hook).toHaveBeenCalledTimes(1)
        expect(resolver).toHaveBeenCalledTimes(1)
        expect(scope.get(request.context)?.authDatabase).toBe(authDatabase)
    })

    it('keeps prepared auth after a CMS failure and retries only the CMS resolver', async () => {
        const database = createMemoryDatabase()
        const failure = new Error('CMS binding unavailable')
        const resolver = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(database)
        const authDatabase = (() => ({})) as never
        const hook = vi.fn((context) => {
            context.authDatabase = authDatabase
        })
        const scope = createSiteAdminDatabaseScope(resolver, hook)
        const request = event()
        await scope.prepare(request)
        await expect(scope.resolve(request)).rejects.toBe(failure)
        expect(scope.get(request.context)?.authDatabase).toBe(authDatabase)
        expect((await scope.resolve(request)).database).toBe(database)
        expect(hook).toHaveBeenCalledTimes(1)
        expect(resolver).toHaveBeenCalledTimes(2)
    })

    it('retries a failed hook without retaining partial native auth state', async () => {
        const resolver = vi.fn(() => createMemoryDatabase())
        const failure = new Error('Hook failed')
        const hook = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
        const scope = createSiteAdminDatabaseScope(resolver, hook)
        const request = event()
        await expect(scope.resolve(request)).rejects.toBe(failure)
        expect(scope.get(request.context)).toBeUndefined()
        expect(resolver).not.toHaveBeenCalled()
        await scope.resolve(request)
        expect(hook).toHaveBeenCalledTimes(2)
        expect(resolver).toHaveBeenCalledTimes(1)
    })

    it('isolates requests, honors hook adapters, and preserves native platform context identity', async () => {
        const first = createMemoryDatabase()
        const second = createMemoryDatabase()
        const resolver = vi.fn(() => first)
        const a = event()
        const b = event()
        const hook = vi.fn((context) => {
            if (context.event === b) context.database = second
        })
        const scope = createSiteAdminDatabaseScope(resolver, hook)
        expect((await scope.resolve(a)).database).toBe(first)
        expect((await scope.resolve(b)).database).toBe(second)
        expect(resolver).toHaveBeenCalledTimes(1)
        expect(resolver).toHaveBeenCalledWith({ event: a, request: a.req, platformContext: a.context })
        expect(hook).toHaveBeenCalledTimes(2)
    })

    it('resolves event-free tasks independently and never invents request context', async () => {
        const a = { env: {} }
        const b = { env: {} }
        const first = createMemoryDatabase()
        const second = createMemoryDatabase()
        const resolver = vi.fn(({ platformContext }) => (platformContext === a ? first : second))
        const hook = vi.fn()
        const scope = createSiteAdminDatabaseScope(resolver, hook)
        expect((await scope.resolve(undefined, a)).database).toBe(first)
        expect((await scope.resolve(undefined, b)).database).toBe(second)
        expect((await scope.resolve(undefined, a)).database).toBe(first)
        expect(hook).toHaveBeenCalledTimes(3)
        expect(resolver).toHaveBeenNthCalledWith(1, { platformContext: a })
        expect(resolver).toHaveBeenNthCalledWith(2, { platformContext: b })
    })
})
