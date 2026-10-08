import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'

import type { SiteAdminDatabase, SiteAdminStorage } from '../packages/site-admin/src/adapter'
import type { SiteAdminAIRuntime } from '../packages/site-admin/src/ai'
import { defineSiteAdminConfig, markdown, text, textarea } from '../packages/site-admin/src'
import { SiteAdminError } from '../packages/site-admin/src/errors'
import { handleManagementRequest, SiteAdmin, type SiteAdminActor } from '../packages/site-admin/src/server'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const config = defineSiteAdminConfig({
    authorization: {
        roles: {
            editorialAI: { models: { posts: ['ai'] } },
            reader: { models: { posts: ['readDraft'] } },
        },
    },
    modelDefaults: { slug: { maxLength: 42 } },
    models: {
        posts: {
            displayFields: { description: 'summary', title: 'title' },
            fields: { body: markdown(), summary: textarea(), title: text({ required: true }) },
            route: true,
        },
        private: { fields: { secret: text() }, public: false },
    },
})

const setup = <Context = unknown>(
    options: {
        actor?: SiteAdminActor | null
        aiEnabled?: boolean
        aiRuntime?: SiteAdminAIRuntime | ((context?: Context) => Promise<SiteAdminAIRuntime>)
    } = {},
) => {
    const storage = {
        assertSchema: vi.fn(async () => {
            throw new Error('AI proposals must not initialize storage.')
        }),
        insertRevisionData: vi.fn(() => {
            throw new Error('AI proposals must not create revisions.')
        }),
        revisionSource: 'site_admin_revisions',
    } satisfies SiteAdminStorage
    const database = {
        atomic: vi.fn(async () => {
            throw new Error('AI proposals must not write storage.')
        }),
        bind: () => storage,
        dialect: 'sqlite',
        query: vi.fn(async () => {
            throw new Error('AI proposals must not read storage.')
        }),
    } satisfies SiteAdminDatabase
    const admin = new SiteAdmin<Context>({
        ...options,
        authorize: () => (options.actor === undefined ? { id: 'editor', roles: ['editorialAI'] } : options.actor),
        config,
        database,
    })
    return { admin, database, storage }
}

const metadataInput = {
    data: { body: 'Draft body', summary: '', title: 'Draft' },
    generate: { excerpt: true, slug: true },
}
const request = (operation: 'metadata' | 'proofread', body: unknown, model = 'posts') =>
    new Request(`https://example.test/manage/models/${model}/ai/${operation}`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
    })

const runtime = () => ({
    generateMetadata: vi.fn<SiteAdminAIRuntime['generateMetadata']>(async (_model, _definition, input) => ({
        data: { ...input.data, summary: 'Proposed summary' },
        issues: [],
        slug: 'proposed-slug',
    })),
    proofreadDraft: vi.fn<SiteAdminAIRuntime['proofreadDraft']>(async (_model, _definition, input) => ({
        data: { ...input.data, title: 'Proofread title' },
        issues: [{ message: 'A required field is missing.', path: 'summary' }],
    })),
})

describe('unsaved AI management proposals', () => {
    it('uses model permission, forwards definition and slug limits, and never reads or writes entries', async () => {
        const ai = runtime()
        const { admin, database, storage } = setup({ aiRuntime: ai })
        const response = await handleManagementRequest(admin, request('metadata', metadataInput), '/manage')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            data: { ...metadataInput.data, summary: 'Proposed summary' },
            issues: [],
            slug: 'proposed-slug',
        })
        expect(ai.generateMetadata).toHaveBeenCalledWith('posts', config.models.posts, metadataInput, 42)
        expect(metadataInput.data.summary).toBe('')
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')

        const proofread = { data: { body: 'Original', title: 'Draf' }, fields: ['title'] }
        const proofreadResponse = await handleManagementRequest(admin, request('proofread', proofread), '/manage')
        expect(proofreadResponse.status).toBe(200)
        expect(await proofreadResponse.json()).toEqual({
            data: { body: 'Original', title: 'Proofread title' },
            issues: [{ message: 'A required field is missing.', path: 'summary' }],
        })
        expect(ai.proofreadDraft).toHaveBeenCalledWith('posts', config.models.posts, proofread)
        expect(database.query).not.toHaveBeenCalled()
        expect(database.atomic).not.toHaveBeenCalled()
        expect(storage.assertSchema).not.toHaveBeenCalled()
        expect(storage.insertRevisionData).not.toHaveBeenCalled()
    })

    it('resolves AI lazily for each native request context rather than caching the first binding', async () => {
        type Context = { binding: 'first' | 'second' }
        const first = runtime()
        const second = runtime()
        const resolver = vi.fn(async (context?: Context) => (context?.binding === 'first' ? first : second))
        const { admin } = setup<Context>({ aiRuntime: resolver })
        expect(resolver).not.toHaveBeenCalled()
        const firstContext: Context = { binding: 'first' }
        const secondContext: Context = { binding: 'second' }
        await handleManagementRequest(admin, request('metadata', metadataInput), '/manage', firstContext)
        await handleManagementRequest(admin, request('proofread', { data: {} }), '/manage', secondContext)
        expect(resolver.mock.calls).toEqual([[firstContext], [secondContext]])
        expect(first.generateMetadata).toHaveBeenCalledOnce()
        expect(first.proofreadDraft).not.toHaveBeenCalled()
        expect(second.proofreadDraft).toHaveBeenCalledOnce()
        expect(second.generateMetadata).not.toHaveBeenCalled()
    })

    it('requires authentication and the specific model AI permission before resolving a provider', async () => {
        const ai = runtime()
        for (const [actor, model, status] of [
            [null, 'posts', 401],
            [{ id: 'reader', roles: ['reader'] }, 'posts', 403],
            [{ id: 'editor', roles: ['editorialAI'] }, 'private', 403],
        ] as const) {
            const resolver = vi.fn(async () => ai)
            const { admin } = setup({ actor, aiRuntime: resolver })
            const response = await handleManagementRequest(admin, request('metadata', metadataInput, model), '/manage')
            expect(response.status).toBe(status)
            expect(resolver).not.toHaveBeenCalled()
        }
    })

    it('rejects unknown models and cross-origin requests without resolving AI', async () => {
        const resolver = vi.fn(async () => runtime())
        const { admin } = setup({ actor: { id: 'admin', roles: ['admin'] }, aiRuntime: resolver })
        const unknown = await handleManagementRequest(admin, request('metadata', metadataInput, 'missing'), '/manage')
        expect(unknown.status).toBe(404)
        expect(await unknown.json()).toMatchObject({ error: { code: 'SITE_ADMIN_MODEL_NOT_FOUND' } })
        const crossOrigin = request('metadata', metadataInput)
        crossOrigin.headers.set('origin', 'https://other.test')
        expect((await handleManagementRequest(admin, crossOrigin, '/manage')).status).toBe(403)
        const wrongMethod = new Request('https://example.test/manage/models/posts/ai/metadata')
        expect((await handleManagementRequest(admin, wrongMethod, '/manage')).status).toBe(404)
        expect(resolver).not.toHaveBeenCalled()
    })

    it('validates request shapes before resolving bindings and preserves explicit false flags and empty values', async () => {
        const resolver = vi.fn(async () => runtime())
        const { admin } = setup({ aiRuntime: resolver })
        const invalidMetadata = [
            null,
            [],
            {},
            { data: [], generate: {} },
            { data: {} },
            { data: {}, generate: [] },
            { data: {}, generate: { slug: 'yes' } },
            { data: {}, generate: { title: true } },
            { data: {}, generate: {}, slug: 123 },
        ]
        for (const body of invalidMetadata)
            expect((await handleManagementRequest(admin, request('metadata', body), '/manage')).status).toBe(400)
        for (const fields of ['title', [1], null])
            expect(
                (await handleManagementRequest(admin, request('proofread', { data: {}, fields }), '/manage')).status,
            ).toBe(400)
        expect(resolver).not.toHaveBeenCalled()

        const ai = runtime()
        const { admin: enabled } = setup({ aiRuntime: ai })
        const manual = { data: { summary: '', title: 'Manual' }, generate: { excerpt: false, slug: false }, slug: '' }
        expect((await handleManagementRequest(enabled, request('metadata', manual), '/manage')).status).toBe(200)
        expect(ai.generateMetadata).toHaveBeenCalledWith('posts', config.models.posts, manual, 42)
        const unselected = { data: { summary: '', title: 'Manual' }, generate: {}, slug: '' }
        expect((await handleManagementRequest(enabled, request('metadata', unselected), '/manage')).status).toBe(200)
        expect(ai.generateMetadata).toHaveBeenLastCalledWith('posts', config.models.posts, unselected, 42)
    })

    it('rejects invalid JSON and content types without reaching AI', async () => {
        const resolver = vi.fn(async () => runtime())
        const { admin } = setup({ aiRuntime: resolver })
        for (const [body, contentType] of [
            ['{', 'application/json'],
            ['{}', 'text/plain'],
        ] as const) {
            const malformed = new Request('https://example.test/manage/models/posts/ai/metadata', {
                body,
                headers: { 'content-type': contentType! },
                method: 'POST',
            })
            expect((await handleManagementRequest(admin, malformed, '/manage')).status).toBe(400)
        }
        expect(resolver).not.toHaveBeenCalled()
    })

    it('reports unavailable AI only when called and honors disabled AI without resolving its runtime', async () => {
        const resolver = vi.fn(async () => runtime())
        for (const options of [{}, { aiEnabled: false, aiRuntime: resolver }]) {
            const { admin } = setup(options)
            const response = await handleManagementRequest(admin, request('metadata', metadataInput), '/manage')
            expect(response.status).toBe(503)
            expect(await response.json()).toEqual({
                error: { code: 'SITE_ADMIN_AI_UNAVAILABLE', message: 'AI operations are not available.' },
            })
        }
        expect(resolver).not.toHaveBeenCalled()
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        const admin = await createMigratedTestAdmin({ config, database })
        const created = await admin.createEntry('posts', { data: { title: 'No AI binding' } })
        expect((await admin.getEntry(created.id)).data.title).toBe('No AI binding')
        await expect(admin.generateMetadata('posts', metadataInput)).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_UNAVAILABLE',
            status: 503,
        })
    })

    it('sanitizes provider and resolver failures while keeping stable HTTP error codes', async () => {
        for (const [failure, code, status, message] of [
            [new Error('secret provider token and request body'), 'SITE_ADMIN_AI_FAILED', 502, 'AI operation failed.'],
            [new SiteAdminError('SITE_ADMIN_AI_FAILED', 'secret'), 'SITE_ADMIN_AI_FAILED', 502, 'AI operation failed.'],
            [
                new SiteAdminError('SITE_ADMIN_AI_OUTPUT_INVALID', 'secret'),
                'SITE_ADMIN_AI_OUTPUT_INVALID',
                502,
                'AI returned an invalid response.',
            ],
            [
                new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'secret'),
                'SITE_ADMIN_AI_UNAVAILABLE',
                503,
                'AI operations are not available.',
            ],
        ] as const) {
            for (const stage of ['operation', 'resolver']) {
                const ai = runtime()
                ai.generateMetadata.mockRejectedValue(failure)
                const { admin } = setup({
                    aiRuntime:
                        stage === 'operation'
                            ? ai
                            : async () => {
                                  throw failure
                              },
                })
                const response = await handleManagementRequest(admin, request('metadata', metadataInput), '/manage')
                expect(response.status).toBe(status)
                expect(await response.json()).toEqual({ error: { code, message } })
            }
        }
    })
})
