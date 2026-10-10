import { describe, expect, it } from 'vitest'

import {
    createSiteAdminClient,
    createSiteAdminManagementClient,
    managementAssetUrl,
    SiteAdminClientError,
    type PublicEntry,
} from '../packages/site-admin/src/client'
import {
    siteAdminNuxtClientTemplate,
    siteAdminNuxtFormTemplate,
    siteAdminNuxtModelTypes,
} from '../packages/site-admin/src/nuxt/client-templates'

describe('Site Admin clients', () => {
    const preparing = (searchRemaining: unknown, status = 503, code = 'SITE_ADMIN_SEARCH_PREPARING') =>
        Response.json({ error: { code, message: 'Preparing.', searchRemaining } }, { status })

    it('resumes only progressing search GETs with the same query and signal, including paginated reads', async () => {
        const controller = new AbortController()
        const calls: string[] = []
        const entries = [
            { id: 'one', data: {} },
            { id: 'two', data: {} },
        ]
        const client = createSiteAdminManagementClient({
            fetch: async (input, init) => {
                calls.push(String(input))
                expect(init?.method).toBe('GET')
                expect(init?.signal).toBe(controller.signal)
                if (calls.length <= 2) return preparing(3 - calls.length)
                const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'))
                return Response.json({ items: entries.slice(offset, offset + 1), total: 2 })
            },
        })
        expect(await client.listAllEntries('posts', { q: 'needle', limit: 1, signal: controller.signal })).toEqual(
            entries,
        )
        expect(calls).toHaveLength(4)
        expect(calls[0]).toBe(calls[1])
        expect(calls[1]).toBe(calls[2])
        expect(calls[3]).toContain('offset=1')
    })

    it.each([{ counts: [4, 4] }, { counts: [4, 5] }])(
        'stops a search whose remaining count does not decrease: %j',
        async ({ counts }) => {
            let calls = 0
            const client = createSiteAdminManagementClient({ fetch: async () => preparing(counts[calls++] ?? 1) })
            await expect(client.listEntries('posts', { q: 'needle' })).rejects.toMatchObject({
                code: 'SITE_ADMIN_SEARCH_PREPARING',
            })
            expect(calls).toBe(2)
        },
    )

    it.each([undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        'rejects malformed search progress without retry: %j',
        async (remaining) => {
            let calls = 0
            const client = createSiteAdminManagementClient({
                fetch: async () => {
                    calls++
                    return preparing(remaining)
                },
            })
            await expect(client.listEntries('posts', { q: 'needle' })).rejects.toMatchObject({ status: 503 })
            expect(calls).toBe(1)
        },
    )

    it.each([
        [500, 'SITE_ADMIN_SEARCH_PREPARING'],
        [503, 'SITE_ADMIN_STORAGE_UNAVAILABLE'],
        [401, 'SITE_ADMIN_AUTH_REQUIRED'],
        [403, 'SITE_ADMIN_FORBIDDEN'],
    ])('preserves ordinary and authorization errors without retry: %i %s', async (status, code) => {
        let calls = 0
        const client = createSiteAdminManagementClient({
            fetch: async () => {
                calls++
                return preparing(1, status, code)
            },
        })
        await expect(client.listEntries('posts', { q: 'needle' })).rejects.toMatchObject({ status, code })
        expect(calls).toBe(1)
    })

    it('stops cancellation between preparation GETs and rejects an already cancelled search before transport', async () => {
        const controller = new AbortController()
        let calls = 0
        const client = createSiteAdminManagementClient({
            fetch: async (_input, init) => {
                calls++
                expect(init?.signal).toBe(controller.signal)
                controller.abort()
                return preparing(1)
            },
        })
        await expect(client.listEntries('posts', { q: 'needle', signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        })
        expect(calls).toBe(1)
        await expect(client.listAllEntries('posts', { q: 'needle', signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        })
        expect(calls).toBe(1)
    })

    it('never retries unfiltered reads, other GETs, writes, or AI even when they return search preparation errors', async () => {
        let calls = 0
        const client = createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
            fetch: async () => {
                calls++
                return preparing(1)
            },
        })
        const operations = [
            () => client.listEntries('posts'),
            () => client.listAllEntries('posts', { q: '' }),
            () => client.models(),
            () => client.getEntry('entry'),
            () => client.createEntry('posts', { data: {} }),
            () => client.updateEntry('entry', { data: {}, expectedVersion: 1 }),
            () => client.deleteEntry('entry', { expectedVersion: 1 }),
            () => client.runAiAction('metadata', { props: {} }),
        ]
        for (const [index, operation] of operations.entries()) {
            await expect(operation()).rejects.toMatchObject({ code: 'SITE_ADMIN_SEARCH_PREPARING', status: 503 })
            expect(calls).toBe(index + 1)
        }
    })

    it('preserves public projection, encoding, locale and nullable lookup contracts', async () => {
        const calls: Array<{ input: string; method?: string }> = []
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            basePath: '/content/',
            origin: 'https://example.test/',
            fetch: async (input, init) => {
                calls.push({ input: String(input), ...(init?.method ? { method: init.method } : {}) })
                if (String(input).includes('/missing')) return Response.json(null, { status: 404 })
                const document = {
                    data: { _siteAdmin: { id: 'entry', model: 'posts', slug: 'hello' }, title: 'Hello' },
                }
                return Response.json(String(input).includes('/hello') ? document : [document])
            },
        })
        expect(await client.list('posts', { locale: 'ja' })).toEqual([
            { data: { title: 'Hello' }, id: 'entry', model: 'posts', slug: 'hello' },
        ])
        expect(await client.get('posts', 'hello')).toMatchObject({ data: { title: 'Hello' }, id: 'entry' })
        expect(await client.get('posts', 'missing')).toBeNull()
        expect(client.assetUrl('image/a')).toBe('https://example.test/content/_assets/image%2Fa')
        expect(calls).toEqual([
            { input: 'https://example.test/content/posts?locale=ja', method: 'GET' },
            { input: 'https://example.test/content/posts/hello', method: 'GET' },
            { input: 'https://example.test/content/posts/missing', method: 'GET' },
        ])
    })

    it('forwards caller AbortSignals through the public get/list/route transport', async () => {
        const controller = new AbortController()
        const signals: Array<AbortSignal | null | undefined> = []
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            fetch: async (input, init) => {
                signals.push(init?.signal)
                if (String(input).endsWith('/posts')) return Response.json([])
                return Response.json(null, { status: 404 })
            },
        })
        await client.get('posts', 'missing', { signal: controller.signal })
        await client.list('posts', { signal: controller.signal })
        await client.resolveRoute('/missing', { signal: controller.signal })
        expect(signals).toEqual([controller.signal, controller.signal, controller.signal])
    })

    it('notifies successfully scheduled publications while keeping follow-up read errors separate from task success', async () => {
        const mutations: Array<{ id: string; model?: string }> = []
        const client = createSiteAdminManagementClient({
            onMutation: (mutation) => {
                mutations.push(mutation)
            },
            fetch: async (input, init) => {
                if (init?.method === 'POST')
                    return Response.json({
                        published: ['readable', 'denied'],
                        failed: [{ entryId: 'failed', message: 'Conflict' }],
                    })
                if (String(input).endsWith('/denied'))
                    return Response.json(
                        { error: { code: 'SITE_ADMIN_FORBIDDEN', message: 'Denied' } },
                        { status: 403 },
                    )
                return Response.json({ id: 'readable', model: 'posts', version: 2 })
            },
        })
        const result = await client.publishDue()
        expect(result.published).toEqual(['readable', 'denied'])
        expect(mutations).toEqual(
            expect.arrayContaining([{ id: 'readable', model: 'posts', version: 2 }, { id: 'denied' }]),
        )
        expect(mutations.some(({ id }) => id === 'failed')).toBe(false)
    })

    it('matches management CRUD, publication, sort and revision HTTP routes without assuming mutation data', async () => {
        const calls: Array<{ body?: unknown; headers: Headers; method: string; url: string }> = []
        const client = createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
            basePath: '/manage/',
            fetch: async (input, init) => {
                expect(init?.credentials).toBe('same-origin')
                calls.push({
                    ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
                    headers: new Headers(init?.headers),
                    method: init?.method ?? 'GET',
                    url: String(input),
                })
                if (init?.method === 'DELETE') return new Response(null, { status: 204 })
                return Response.json({ id: 'entry', model: 'posts', sortOrder: null, version: 2 })
            },
        })
        expect(
            await client.createEntry('posts', { data: { title: 'Created' }, locale: 'ja', slug: 'created' }),
        ).toEqual({
            id: 'entry',
            model: 'posts',
            sortOrder: null,
            version: 2,
        })
        await client.updateEntry('entry/1', { data: { title: 'Edited' }, expectedVersion: 2 })
        await client.publishEntry('entry/1', { expectedVersion: 3, revisionId: 'revision/1' })
        await client.unpublishEntry('entry/1', { expectedVersion: 4 })
        await client.schedulePublish('entry/1', { at: '2026-12-01T00:00:00.000Z', expectedVersion: 5 })
        await client.cancelScheduledPublish('entry/1', { expectedVersion: 6 })
        await client.setSortOrder('entry/1', 4, 7)
        await client.setSortOrders('posts', [{ expectedVersion: 8, id: 'entry/1', sortOrder: null }])
        await client.listRevisions('entry/1')
        await client.restoreRevision('entry/1', 'revision/1', { expectedVersion: 9 })
        await client.pruneRevisions('entry/1', 2)
        await client.deleteEntry('entry/1', { expectedVersion: 10 })
        expect(calls.map(({ body, method, url }) => ({ body, method, url }))).toEqual([
            {
                body: { data: { title: 'Created' }, locale: 'ja', slug: 'created' },
                method: 'POST',
                url: '/manage/entries/posts',
            },
            {
                body: { data: { title: 'Edited' }, expectedVersion: 2 },
                method: 'PATCH',
                url: '/manage/entries/entry%2F1',
            },
            {
                body: { expectedVersion: 3, revisionId: 'revision/1' },
                method: 'POST',
                url: '/manage/entries/entry%2F1/publish',
            },
            { body: { expectedVersion: 4 }, method: 'POST', url: '/manage/entries/entry%2F1/unpublish' },
            {
                body: { at: '2026-12-01T00:00:00.000Z', expectedVersion: 5 },
                method: 'POST',
                url: '/manage/entries/entry%2F1/schedule',
            },
            { body: { expectedVersion: 6 }, method: 'POST', url: '/manage/entries/entry%2F1/cancel-schedule' },
            { body: { expectedVersion: 7, sortOrder: 4 }, method: 'PATCH', url: '/manage/entries/entry%2F1/sort' },
            {
                body: { items: [{ expectedVersion: 8, id: 'entry/1', sortOrder: null }] },
                method: 'POST',
                url: '/manage/entries/posts/reorder',
            },
            { body: undefined, method: 'GET', url: '/manage/entries/entry%2F1/revisions' },
            {
                body: { expectedVersion: 9 },
                method: 'POST',
                url: '/manage/entries/entry%2F1/revisions/revision%2F1/restore',
            },
            { body: { retain: 2 }, method: 'POST', url: '/manage/entries/entry%2F1/revisions/prune' },
            { body: undefined, method: 'DELETE', url: '/manage/entries/entry%2F1' },
        ])
        expect(calls.at(-1)!.headers.get('if-match')).toBe('"10"')
        expect(calls.at(-1)!.headers.has('content-type')).toBe(false)
        expect(client.assetUrl('image/a')).toBe('/manage/assets/image%2Fa/content')
        expect(managementAssetUrl('image/a', '/manage/')).toBe(client.assetUrl('image/a'))
    })

    it('serializes list/reference queries and exposes diagnostics, AI and task endpoints', async () => {
        const urls: string[] = []
        const client = createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
            fetch: async (input) => {
                urls.push(String(input))
                return Response.json({})
            },
        })
        await client.listEntries('posts', { limit: 5, locale: 'ja', offset: 10, q: 'hello world' })
        await client.listEntries()
        await client.referencesTo('entry', { field: 'sections.0.author', from: 'posts', view: 'published' })
        await client.models()
        await client.inspect()
        await client.routeSnapshot()
        await client.runAiAction('suggest/title', { props: { instruction: 'Shorten' } })
        await client.publishDue()
        await client.runAssetGC()
        expect(urls).toEqual([
            '/api/site-admin/entries?model=posts&limit=5&locale=ja&offset=10&q=hello+world',
            '/api/site-admin/entries',
            '/api/site-admin/entries/entry/references?field=sections.0.author&from=posts&view=published',
            '/api/site-admin/models',
            '/api/site-admin/diagnostics',
            '/api/site-admin/routes',
            '/api/site-admin/ai/actions/suggest%2Ftitle',
            '/api/site-admin/tasks/publish-due',
            '/api/site-admin/tasks/asset-gc',
        ])
    })

    it('collects more than 100 management entries using default pages and preserves their order', async () => {
        const entries = Array.from({ length: 205 }, (_, index) => ({
            id: `entry-${index}`,
            data: { title: String(index) },
        }))
        const offsets: number[] = []
        const client = createSiteAdminManagementClient<Record<string, { title: string }>>({
            fetch: async (input) => {
                const url = new URL(String(input), 'http://localhost')
                const offset = Number(url.searchParams.get('offset'))
                offsets.push(offset)
                expect(url.searchParams.get('model')).toBe('posts')
                expect(url.searchParams.get('limit')).toBe('100')
                return Response.json({
                    items: entries.slice(offset, offset + 100),
                    limit: 100,
                    offset,
                    total: entries.length,
                })
            },
        })
        expect(await client.listAllEntries('posts')).toEqual(entries)
        expect(offsets).toEqual([0, 100, 200])
    })

    it('keeps page options and advances offsets by returned items rather than the requested limit', async () => {
        const entries = Array.from({ length: 5 }, (_, index) => ({
            id: `entry-${index}`,
            data: { title: String(index) },
        }))
        const offsets: number[] = []
        const client = createSiteAdminManagementClient<Record<string, { title: string }>>({
            basePath: '/manage',
            fetch: async (input) => {
                const url = new URL(String(input), 'http://localhost')
                const offset = Number(url.searchParams.get('offset'))
                offsets.push(offset)
                expect(url.pathname).toBe('/manage/entries')
                expect(url.searchParams.get('model')).toBe('posts')
                expect(url.searchParams.get('limit')).toBe('5')
                expect(url.searchParams.get('locale')).toBe('ja')
                expect(url.searchParams.get('q')).toBe('hello world')
                return Response.json({ items: entries.slice(offset, offset + 2), limit: 5, offset, total: 5 })
            },
        })
        expect(await client.listAllEntries('posts', { limit: 5, locale: 'ja', q: 'hello world' })).toEqual(entries)
        expect(offsets).toEqual([0, 2, 4])
    })

    it('rejects an empty intermediate page instead of returning a partial list or looping', async () => {
        const offsets: number[] = []
        const client = createSiteAdminManagementClient({
            fetch: async (input) => {
                const offset = Number(new URL(String(input), 'http://localhost').searchParams.get('offset'))
                offsets.push(offset)
                return Response.json({ items: offset === 0 ? [{ id: 'entry' }] : [], limit: 100, offset, total: 2 })
            },
        })
        await expect(client.listAllEntries('posts')).rejects.toMatchObject({
            code: 'SITE_ADMIN_INVALID_RESPONSE',
            message: 'Entry list changed. Reload latest.',
        })
        expect(offsets).toEqual([0, 1])
    })

    it('honors changing totals and allows an empty unfiltered list', async () => {
        let calls = 0
        const client = createSiteAdminManagementClient({
            fetch: async (input) => {
                const url = new URL(String(input), 'http://localhost')
                expect(url.searchParams.has('model')).toBe(false)
                calls += 1
                return Response.json({
                    items: calls === 1 ? [{ id: 'first' }] : [{ id: 'second' }],
                    limit: 100,
                    offset: calls - 1,
                    total: calls === 1 ? 10 : 2,
                })
            },
        })
        expect(await client.listAllEntries()).toEqual([{ id: 'first' }, { id: 'second' }])
        expect(calls).toBe(2)
        const empty = createSiteAdminManagementClient({
            fetch: async () => Response.json({ items: [], limit: 100, offset: 0, total: 0 }),
        })
        expect(await empty.listAllEntries()).toEqual([])
    })

    it('uploads raw files with encoded names, retains download responses and handles 204 deletes', async () => {
        const file = new File(['bytes'], '画像 file.txt', { type: 'text/plain' })
        const client = createSiteAdminManagementClient({
            fetch: async (input, init) => {
                if (init?.method === 'POST') {
                    expect(init.body).toBe(file)
                    const headers = new Headers(init.headers)
                    expect(headers.get('x-filename')).toBe(encodeURIComponent(file.name))
                    expect(headers.get('x-upload-size')).toBe('5')
                    expect(headers.get('content-type')).toBe('text/plain')
                    return Response.json({ id: 'asset', size: 5 })
                }
                if (String(input).endsWith('/content')) return new Response('bytes', { headers: { etag: '"asset"' } })
                if (init?.method === 'DELETE') return new Response(null, { status: 204 })
                return Response.json({ id: 'asset', size: 5 })
            },
        })
        expect(await client.uploadAsset(file)).toMatchObject({ id: 'asset', size: 5 })
        expect(await client.getAsset('asset')).toMatchObject({ id: 'asset' })
        const download = await client.downloadAsset('asset')
        expect(download.headers.get('etag')).toBe('"asset"')
        expect(await download.text()).toBe('bytes')
        expect(await client.deleteAsset('asset')).toBeUndefined()
    })

    it('keeps structured management errors and fails on malformed public metadata', async () => {
        const client = createSiteAdminManagementClient({
            fetch: async () =>
                Response.json(
                    {
                        error: {
                            code: 'SITE_ADMIN_CONFLICT',
                            issues: [{ message: 'Already used.', path: 'title' }],
                            message: 'Changed.',
                        },
                    },
                    { status: 409 },
                ),
        })
        await expect(client.deleteEntry('entry', { expectedVersion: 1 })).rejects.toMatchObject({
            code: 'SITE_ADMIN_CONFLICT',
            issues: [{ message: 'Already used.', path: 'title' }],
            status: 409,
        })
        const broken = createSiteAdminClient<Record<string, PublicEntry>>({
            fetch: async () => Response.json([{ data: {} }]),
        })
        await expect(broken.list('posts')).rejects.toBeInstanceOf(SiteAdminClientError)
        const unavailable = createSiteAdminManagementClient({
            fetch: async () => new Response('Unavailable', { status: 503 }),
        })
        await expect(unavailable.models()).rejects.toMatchObject({ code: 'SITE_ADMIN_REQUEST_FAILED', status: 503 })
    })

    it('generates public/management helpers independently from the optional form peer and server config', () => {
        const source = siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage' })
        expect(source).toContain('useSiteAdminManagementClient')
        expect(source).toContain('useRequestFetch()')
        expect(source).not.toContain('@liria24/site-admin/form')
        expect(source).toContain("import { createUseAsyncData } from '#app/composables/asyncData'")
        expect(source).toContain('export const siteAdminAsyncData = createUseAsyncData()')
        expect(source).toContain('return siteAdminAsyncData(() => key.value')
        expect(source).not.toContain('async function useSiteAdminEntry')
        expect(source).not.toContain('async function useSiteAdminList')
        expect(source).not.toContain('__nuxt_factory')
        expect(source).not.toContain('_createUseAsyncData')
        const form = siteAdminNuxtFormTemplate()
        expect(form).toContain("from '@liria24/site-admin/form'")
        expect(form).toContain('modelName: modelOrOptions')
        expect(form).toContain('useSiteAdminModels(requestOptions, auth)')
        expect(form).not.toContain('const models:')
        expect(form).not.toContain('JSON.stringify')
        expect(form).not.toContain('default:')
        expect(form).not.toContain('options.descriptor')
        const types = siteAdminNuxtModelTypes('C:\\project\\site-admin.config.ts', ['production', 'preview'])
        expect(types).toContain('C:/project/site-admin.config.ts')
        expect(types).toContain('publicModels: InferSiteAdminPublicModels<SiteAdminDomainConfig>')
        expect(types).toContain('readonly ["production", "preview"]')
    })

    it.each([
        ['C:\\project name\\site-admin.config.ts', 'C:/project name/site-admin.config.ts'],
        ['C:\\site-admin.config.ts', 'C:/site-admin.config.ts'],
        ['\\\\server\\share\\site-admin.config.ts', '//server/share/site-admin.config.ts'],
        ['/app/config #1%[preview].ts', '/app/config #1%[preview].ts'],
    ])('preserves config import paths in generated model types: %s', (path, expected) => {
        const types = siteAdminNuxtModelTypes(path)
        expect(types).toContain(`typeof import(${JSON.stringify(expected)}).default`)
    })
})
