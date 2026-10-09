import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { ref, toValue } from 'vue'

import {
    createSiteAdminClient,
    SiteAdminClientError,
    type SiteAdminClient,
    type PublicEntry,
} from '../packages/site-admin/src/client'
import {
    siteAdminNuxtBatchTransportTemplate,
    siteAdminNuxtClientTemplate,
} from '../packages/site-admin/src/nuxt/client-templates'

interface ResolvedRequest {
    name: string
    operation: 'list' | 'entry'
    model: string
    slug: string | null
}
interface BatchItem {
    data: PublicEntry[] | PublicEntry | null
    error: { code: string; message: string; status: number; issues?: Array<{ path: string; message: string }> } | null
}
interface BatchHelpers {
    snapshot(
        requests: Record<
            string,
            { list: string } | { entry: string; slugOrId: string | ReturnType<typeof ref<string>> | (() => string) }
        >,
    ): ResolvedRequest[]
    key(
        connection: { origin?: string; basePath?: string },
        requests: readonly ResolvedRequest[],
        locale?: string,
    ): string
    resolve(
        client: SiteAdminClient<Record<string, PublicEntry>>,
        requests: readonly ResolvedRequest[],
        locale: string | undefined,
        signal: AbortSignal,
    ): Promise<Record<string, BatchItem>>
}

// Execute only the generated bounded transport helpers. No factory or AsyncData/cache implementation is mocked.
const source = stripTypeScriptTypes(siteAdminNuxtBatchTransportTemplate('/content')).replace(/^export /gmu, '')
const initialize = new Function(
    'SiteAdminClientError',
    'toValue',
    `${source}\nreturn { snapshot: siteAdminSnapshotBatchRequests, key: siteAdminBatchDataKey, resolve: siteAdminResolveBatch }`,
) as (...dependencies: unknown[]) => BatchHelpers
const helpers = initialize(SiteAdminClientError, toValue)

const document = (model: string, id: string) => ({ data: { _siteAdmin: { id, model, slug: id }, title: id } })

describe('generated public batch transport', () => {
    it('keeps successful requests, serializes item failures, and distinguishes a missing entry', async () => {
        const signal = new AbortController().signal
        const calls: Array<{ path: string; signal: AbortSignal | null | undefined }> = []
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            fetch: async (input, init) => {
                const url = new URL(String(input), 'http://localhost')
                calls.push({ path: url.pathname, signal: init?.signal })
                expect(url.searchParams.get('locale')).toBe('ja')
                if (url.pathname.endsWith('/arts')) return Response.json([document('arts', 'art')])
                if (url.pathname.endsWith('/posts/good')) return Response.json(document('posts', 'good'))
                if (url.pathname.endsWith('/posts/missing')) return Response.json(null, { status: 404 })
                return Response.json(
                    {
                        error: {
                            code: 'SITE_ADMIN_UNAVAILABLE',
                            message: 'Unavailable.',
                            issues: [{ path: 'title', message: 'Bad.', stack: 'private' }],
                            stack: 'private',
                            cause: 'private',
                        },
                    },
                    { status: 503 },
                )
            },
        })
        const result = await helpers.resolve(
            client,
            helpers.snapshot({
                arts: { list: 'arts' },
                posts: { list: 'posts' },
                featured: { entry: 'posts', slugOrId: 'good' },
                missing: { entry: 'posts', slugOrId: 'missing' },
                failedEntry: { entry: 'posts', slugOrId: 'failed' },
            }),
            'ja',
            signal,
        )
        expect(result.arts).toMatchObject({ data: [{ id: 'art' }], error: null })
        expect(result.featured).toMatchObject({ data: { id: 'good' }, error: null })
        expect(result.missing).toEqual({ data: null, error: null })
        expect(result.posts).toEqual({
            data: [],
            error: {
                code: 'SITE_ADMIN_UNAVAILABLE',
                message: 'Unavailable.',
                status: 503,
                issues: [{ path: 'title', message: 'Bad.' }],
            },
        })
        expect(result.failedEntry?.data).toBeNull()
        expect(result.failedEntry?.error?.status).toBe(503)
        expect(calls).toHaveLength(5)
        expect(calls.every((call) => call.signal === signal)).toBe(true)
        expect(JSON.stringify(result)).not.toContain('private')
        expect(JSON.stringify(result)).not.toContain('stack')
        expect(JSON.stringify(result)).not.toContain('cause')
    })

    it('starts request promises in parallel and gives no-response failures status zero', async () => {
        const started: string[] = []
        let finish: ((response: Response) => void) | undefined
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            fetch: (input) => {
                started.push(String(input))
                if (String(input).endsWith('/arts'))
                    return new Promise((resolve) => {
                        finish = resolve
                    })
                return Promise.reject(new TypeError('Network unavailable.'))
            },
        })
        const pending = helpers.resolve(
            client,
            helpers.snapshot({ arts: { list: 'arts' }, posts: { list: 'posts' } }),
            undefined,
            new AbortController().signal,
        )
        expect(started).toEqual(['/api/content/arts', '/api/content/posts'])
        finish!(Response.json([document('arts', 'art')]))
        const result = await pending
        expect(result.arts?.error).toBeNull()
        expect(result.posts?.error).toEqual({
            code: 'SITE_ADMIN_REQUEST_FAILED',
            message: 'Network unavailable.',
            status: 0,
        })
    })

    it('uses canonical named tuples and tracks reactive slugs, locale and connection isolation', () => {
        const slug = ref('first')
        const first = helpers.snapshot({ z: { entry: 'posts', slugOrId: slug }, a: { list: 'arts' } })
        const reversed = helpers.snapshot({ a: { list: 'arts' }, z: { entry: 'posts', slugOrId: () => slug.value } })
        expect(first).toEqual(reversed)
        const connection = { origin: 'https://a.example', basePath: '/content' }
        const key = helpers.key(connection, first, 'ja')
        expect(key).toBe(helpers.key(connection, reversed, 'ja'))
        expect(key).not.toBe(helpers.key(connection, first, 'en'))
        expect(key).not.toBe(helpers.key({ ...connection, origin: 'https://b.example' }, first, 'ja'))
        expect(key).not.toBe(helpers.key({ ...connection, basePath: '/other' }, first, 'ja'))
        slug.value = 'second'
        expect(key).not.toBe(
            helpers.key(
                connection,
                helpers.snapshot({ z: { entry: 'posts', slugOrId: slug }, a: { list: 'arts' } }),
                'ja',
            ),
        )
    })

    it('rejects cancellation for the entire batch rather than serializing aborted partial data', async () => {
        const controller = new AbortController()
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            fetch: async (input, init) => {
                if (String(input).endsWith('/arts')) return Response.json([document('arts', 'art')])
                return new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
                })
            },
        })
        const pending = helpers.resolve(
            client,
            helpers.snapshot({ arts: { list: 'arts' }, posts: { list: 'posts' } }),
            undefined,
            controller.signal,
        )
        const error = new DOMException('Cancelled.', 'AbortError')
        controller.abort(error)
        await expect(pending).rejects.toBe(error)
        await expect(helpers.resolve(client, [], undefined, controller.signal)).rejects.toBe(error)
    })

    it('generates one native aggregation invocation without nested list/entry composables', () => {
        const template = siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage' })
        const batch = template.slice(template.indexOf('export function useSiteAdminBatch(requests:'))
        expect(batch.match(/return siteAdminAsyncData\(/gu)).toHaveLength(1)
        expect(batch).toContain('siteAdminResolveBatch(client, snapshot.value, locale.value, signal)')
        expect(batch).not.toContain('useSiteAdminList(')
        expect(batch).not.toContain('useSiteAdminEntry(')
        expect(batch).not.toContain('await siteAdminAsyncData')
    })
})
