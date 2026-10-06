import { expect, it } from 'vitest'
import { createError, type RequestEvent } from 'nuxt/server'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { configureSiteAdminRuntime, normalizeSiteAdminAuthorizationError } from '../packages/site-admin/src/nuxt/server'
import management from '../packages/site-admin/src/runtime/management-handler'
import publicHandler from '../packages/site-admin/src/runtime/public-handler'
import middleware from '../packages/site-admin/src/runtime/database-middleware'
import { createSiteAdmin } from '../packages/site-admin/src/server'
import { migrateTestDatabase, testAdapter } from './migrate'

const event = (path: string, authorization?: string, method = 'GET'): RequestEvent => {
    const req = new Request('http://localhost' + path, {
        method,
        ...(authorization ? { headers: { authorization } } : {}),
    })
    return { req, url: new URL(req.url), context: {}, res: { headers: new Headers() } }
}

it('awaits request initialization and keeps context identity isolated', async () => {
    const initialized = new WeakSet<object>()
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
        release = resolve
    })
    configureSiteAdminRuntime({
        publicBase: '/api/content',
        managementBase: '/api/site-admin',
        getSiteAdmin: () => {
            throw new Error('Not needed in middleware')
        },
        initializeRequest: async (request) => {
            await ready
            initialized.add(request.context)
        },
    })
    const first = event('/api/auth/get-session'),
        second = event('/api/auth/get-session')
    const pending = middleware(first)
    expect(initialized.has(first.context)).toBe(false)
    release()
    await pending
    expect(initialized.has(first.context)).toBe(true)
    expect(initialized.has(second.context)).toBe(false)
    await middleware(second)
    expect(initialized.has(second.context)).toBe(true)
})

it('native HTTP handlers preserve intentional auth statuses, redact errors and return Web responses', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
    try {
        await migrateTestDatabase(database, config)
        const adapter = await testAdapter(database, config)
        const admin = createSiteAdmin<RequestEvent>({
            config,
            database: adapter,
            authorize: (_request, context) => {
                try {
                    const mode = context?.req.headers.get('authorization')
                    if (mode === 'denied') throw createError({ status: 403, message: 'PRIVATE_DENIAL' })
                    if (mode === 'broken') throw new Error('PRIVATE_FAILURE')
                    return mode ? { id: mode, roles: ['admin'] } : null
                } catch (error) {
                    throw normalizeSiteAdminAuthorizationError(error)
                }
            },
        })
        configureSiteAdminRuntime({
            publicBase: '/api/content',
            managementBase: '/api/site-admin',
            getSiteAdmin: () => admin,
        })
        for (const [mode, status, code] of [
            [undefined, 401, 'SITE_ADMIN_AUTH_REQUIRED'],
            ['denied', 403, 'SITE_ADMIN_FORBIDDEN'],
            ['broken', 500, 'SITE_ADMIN_INTERNAL_ERROR'],
        ] as const) {
            const response = await management(event('/api/site-admin/models', mode))
            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(status)
            expect(response.headers.get('cache-control')).toBe('private, no-store')
            expect(response.headers.get('x-content-type-options')).toBe('nosniff')
            const body = await response.text()
            expect(JSON.parse(body).error.code).toBe(code)
            expect(body).not.toContain('PRIVATE_')
        }
        const successful = await management(event('/api/site-admin/models', 'admin'))
        expect(successful.status).toBe(200)
        const read = await publicHandler(event('/api/content/posts'))
        expect(read.status).toBe(200)
        expect(read.headers.get('access-control-allow-origin')).toBe('*')
        const head = event('/api/content/posts', undefined, 'HEAD')
        const response = await publicHandler(head)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('')
    } finally {
        await database.dispose()
    }
})
