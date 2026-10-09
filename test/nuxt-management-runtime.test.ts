import { readFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { createError } from 'h3'
import { describe, expect, it } from 'vitest'
import * as Vue from 'vue'
import {
    createSiteAdminClient,
    createSiteAdminManagementClient,
    presentSiteAdminData,
    SiteAdminClientError,
    type SiteAdminManagementClient,
} from '../packages/site-admin/src/client'
import { createSiteAdminDescriptor, defineSiteAdminConfig, image, text } from '../packages/site-admin/src'
import {
    siteAdminNuxtClientTemplate,
    siteAdminNuxtFormTemplate,
} from '../packages/site-admin/src/nuxt/client-templates'
import { useSiteAdminForm } from '../packages/site-admin/src/form'

interface State {
    data: Vue.Ref<unknown>
    refresh(options?: { cachedData?: unknown }): Promise<void>
}
interface Helpers {
    useSiteAdminForm(
        model: string,
        options: Record<string, unknown>,
    ): Promise<ReturnType<typeof useSiteAdminForm<Record<string, unknown>>>>
    useSiteAdminManagementList(model: string, options?: Record<string, unknown>): State
    useSiteAdminManagementEntry(
        model: string,
        id: Vue.MaybeRefOrGetter<string>,
        options?: Record<string, unknown>,
    ): State
    useSiteAdminList(model: string, options?: Record<string, unknown>): State
    useSiteAdminEntry(model: string, id: string, options?: Record<string, unknown>): State
    useSiteAdminBatch(requests: Record<string, unknown>, options?: Record<string, unknown>): State
    useSiteAdminManagementClient(): SiteAdminManagementClient<Record<string, Record<string, unknown>>>
    createNuxtSiteAdminManagementClient(
        connection: { origin: string; basePath: string; fetch: typeof fetch },
        auth: Vue.MaybeRefOrGetter<string>,
    ): SiteAdminManagementClient<Record<string, Record<string, unknown>>>
}

const nativeEnvironment = async (request: typeof fetch) => {
    const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
    const root = dirname(requireNuxt.resolve('nuxt/package.json'))
    const script = (source: string) => source.replace(/^import .*$/gmu, '').replace(/^export .*$/gmu, '')
    const native = script(await readFile(join(root, 'dist/app/composables/asyncData.js'), 'utf8'))
        .replace(/^const createUseAsyncData =.*?^\}\);/gmsu, '')
        .replaceAll('import.meta.client', 'true')
        .replaceAll('import.meta.server', 'false')
        .replaceAll('import.meta.dev', 'false')
        .replaceAll('import.meta.prerender', 'false')
    const hooks = new Map<string, Set<(...args: unknown[]) => unknown>>()
    const hook = (name: string, callback: (...args: unknown[]) => unknown) => {
        const callbacks = hooks.get(name) ?? new Set()
        callbacks.add(callback)
        hooks.set(name, callbacks)
        return () => {
            callbacks.delete(callback)
        }
    }
    const app = {
        _asyncData: Vue.shallowReactive({}),
        _asyncDataPromises: {},
        payload: { data: Vue.shallowReactive({} as Record<string, unknown>), _errors: {}, serverRendered: false },
        static: { data: {} as Record<string, unknown> },
        isHydrating: false,
        hook,
        hooks: {
            callHookParallel: async (name: string, ...args: unknown[]) => {
                await Promise.all([...(hooks.get(name) ?? [])].map((callback) => callback(...args)))
            },
        },
        runWithContext: <Value>(callback: () => Value): Value => callback(),
    }
    const debounceSource = script(await readFile(join(root, 'dist/app/utils/debounce-tick.js'), 'utf8'))
    const debounceTick = new Function('queuePostFlushCb', `${debounceSource}; return debounceTick`)(
        Vue.queuePostFlushCb,
    ) as unknown
    const nativeDependencies = {
        ...Object.fromEntries(Object.entries(Vue).filter(([name]) => /^[a-zA-Z_$][a-zA-Z_$0-9]*$/u.test(name))),
        useNuxtApp: () => app,
        createError,
        debounceTick,
        asyncDataDefaults: { deep: false },
        granularCachedData: true,
        pendingWhenIdle: false,
        purgeCachedData: false,
        stripNeverHydratedData: false,
        tracingChannelNuxt: false,
        vapor: false,
        clientOnlySymbol: Symbol('client-only'),
        onNuxtReady: (callback: () => void) => callback(),
        toArray: (value: unknown) => (Array.isArray(value) ? value : [value]),
    }
    const runtime = new Function(
        ...Object.keys(nativeDependencies),
        `${native}; return { useAsyncData, clearNuxtData, refreshNuxtData, useNuxtData }`,
    )(...Object.values(nativeDependencies)) as Record<string, unknown>
    const generated = stripTypeScriptTypes(
        siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage' }),
    )
        .replace(/^import .*$/gmu, '')
        .replace(/^export const siteAdminAsyncData = createUseAsyncData\(\)\s*$/gmu, '')
        .replace(/^export /gmu, '')
        .replaceAll('import.meta.server', 'false')
    const dependencies = {
        ...Object.fromEntries(Object.entries(Vue).filter(([name]) => /^[a-zA-Z_$][a-zA-Z_$0-9]*$/u.test(name))),
        ...runtime,
        siteAdminAsyncData: runtime.useAsyncData,
        createSiteAdminClient,
        createSiteAdminManagementClient,
        presentSiteAdminData,
        SiteAdminClientError,
        useNuxtApp: () => app,
        useRequestURL: () => new URL('http://site.test'),
        globalThis: { fetch: request },
    }
    const helpers = new Function(
        ...Object.keys(dependencies),
        `${generated}; return { useSiteAdminManagementList, useSiteAdminManagementEntry, useSiteAdminEntry, useSiteAdminList, useSiteAdminBatch, useSiteAdminManagementClient, createNuxtSiteAdminManagementClient, siteAdminManagementClientOptions, useSiteAdminModels, siteAdminManagementKey, useSiteAdminAuthScope }`,
    )(...Object.values(dependencies)) as Helpers
    const states = new Map<string, Vue.Ref<unknown>>()
    const formDependencies = {
        ...dependencies,
        ...helpers,
        Vue,
        createForm: useSiteAdminForm,
        useState: (key: string, initialize: () => unknown) => {
            if (!states.has(key)) states.set(key, Vue.ref(initialize()))
            return states.get(key)!
        },
    }
    const formSource = stripTypeScriptTypes(siteAdminNuxtFormTemplate())
        .replace(/^import .*$/gmu, '')
        .replace(/^export /gmu, '')
        .replaceAll('import.meta.server', 'false')
    helpers.useSiteAdminForm = new Function(...Object.keys(formDependencies), `${formSource}; return useSiteAdminForm`)(
        ...Object.values(formDependencies),
    ) as Helpers['useSiteAdminForm']
    return { app, helpers, refreshSubscribers: () => hooks.get('app:data:refresh')?.size ?? 0 }
}
const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Vue.nextTick()
}
const modelDescriptor = createSiteAdminDescriptor(
    defineSiteAdminConfig({
        models: {
            posts: { fields: { title: text({ required: true }), image: image() } },
            authors: { fields: { title: text({ required: true }) } },
        },
    }),
)

describe('native management AsyncData and mutation invalidation', () => {
    it('hydrates an ID-only form from its raw native payload without another descriptor or entry request', async () => {
        let requests = 0
        const { app, helpers } = await nativeEnvironment(async () => {
            requests += 1
            throw new Error('Hydration must use payload')
        })
        app.isHydrating = true
        app.payload.serverRendered = true
        const prefix = ['http://site.test', '/manage', 'alice']
        app.payload.data['site-admin-management:' + JSON.stringify([...prefix, 'models', null, null, null])] =
            modelDescriptor
        app.payload.data['site-admin-management:' + JSON.stringify([...prefix, 'form-entry', 'posts', 'one', null])] = {
            entry: {
                id: 'one',
                model: 'posts',
                locale: '',
                slug: 'one',
                version: 3,
                data: { title: 'Hydrated', image: 'asset' },
            },
        }
        const renderer = Vue.createRenderer<object, object>({
            createComment: () => ({}),
            createElement: () => ({}),
            createText: () => ({}),
            insert: () => {},
            remove: () => {},
            parentNode: () => null,
            nextSibling: () => null,
            patchProp: () => {},
            setElementText: () => {},
            setText: () => {},
        })
        let controller: ReturnType<typeof useSiteAdminForm<Record<string, unknown>>> | undefined
        const component = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                controller = await helpers.useSiteAdminForm('posts', { id: 'one', authScope: 'alice' })
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        component.mount({})
        await flush()
        expect(controller?.form.state.values.title).toBe('Hydrated')
        expect(controller?.baseVersion.value).toBe(3)
        expect(controller?.dirty.value).toBe(false)
        expect(requests).toBe(0)
        component.unmount()
    })
    it('aborts native ID getter loads and restores drafts across navigation, separating a changed actor', async () => {
        const id = Vue.ref('one')
        const actor = Vue.ref('alice')
        const slow = Promise.withResolvers<Response>()
        const started = Promise.withResolvers<void>()
        let slowSignal: AbortSignal | undefined
        const record = (entryId: string) => ({
            id: entryId,
            model: 'posts',
            locale: '',
            slug: entryId,
            version: 1,
            data: { title: actor.value + ' ' + entryId },
        })
        const { helpers } = await nativeEnvironment(async (input, init) => {
            const path = new URL(String(input)).pathname
            if (path.endsWith('/models')) return Response.json(modelDescriptor)
            const requestedId = path.split('/').at(-1)!
            if (requestedId === 'slow') {
                slowSignal = init?.signal ?? undefined
                started.resolve()
                return slow.promise
            }
            return Response.json(record(requestedId))
        })
        const renderer = Vue.createRenderer<object, object>({
            createComment: () => ({}),
            createElement: () => ({}),
            createText: () => ({}),
            insert: () => {},
            remove: () => {},
            parentNode: () => null,
            nextSibling: () => null,
            patchProp: () => {},
            setElementText: () => {},
            setText: () => {},
        })
        let controller: ReturnType<typeof useSiteAdminForm<Record<string, unknown>>> | undefined
        const component = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                controller = await helpers.useSiteAdminForm('posts', {
                                    id: () => id.value,
                                    authScope: actor,
                                })
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        component.mount({})
        await flush()
        expect(controller?.form.state.values.title).toBe('alice one')
        controller!.form.setFieldValue('title', 'Unsaved one')
        await Vue.nextTick()
        id.value = 'slow'
        await started.promise
        id.value = 'two'
        await flush()
        expect(slowSignal?.aborted).toBe(true)
        slow.resolve(Response.json(record('slow')))
        await flush()
        expect(controller?.entryId.value).toBe('two')
        expect(controller?.form.state.values.title).toBe('alice two')
        id.value = 'one'
        await flush()
        expect(controller?.form.state.values.title).toBe('Unsaved one')
        actor.value = 'bob'
        await flush()
        expect(controller?.form.state.values.title).toBe('bob one')
        expect(controller?.dirty.value).toBe(false)
        component.unmount()
    })

    it('refreshes the same actor/model list, affected entry and dependent batch, preserving unrelated caches', async () => {
        let version = 1
        const calls: Record<string, number> = {}
        const request: typeof fetch = async (input, init) => {
            const url = new URL(String(input))
            const method = init?.method ?? 'GET'
            const key = method + ' ' + url.pathname + url.search
            calls[key] = (calls[key] ?? 0) + 1
            const model = url.searchParams.get('model') ?? (url.pathname.includes('/authors') ? 'authors' : 'posts')
            const record = (id = 'one') => ({
                id,
                model,
                data: { title: 'v' + version, image: 'asset' },
                version,
                slug: id,
                locale: '',
            })
            if (method === 'PATCH') {
                version += 1
                return Response.json(record())
            }
            if (url.pathname === '/manage/models') return Response.json(modelDescriptor)
            if (url.pathname === '/manage/entries')
                return Response.json({ items: [record()], total: 1, limit: 20, offset: 0 })
            if (url.pathname.startsWith('/manage/entries/'))
                return Response.json(record(url.pathname.split('/').at(-1)))
            const publicRecord = (id = 'one') => ({
                data: { _siteAdmin: { id, model, slug: id }, title: 'v' + version },
            })
            return Response.json(
                url.pathname.split('/').length === 3 ? [publicRecord()] : publicRecord(url.pathname.split('/').at(-1)),
            )
        }
        const { app, helpers } = await nativeEnvironment(request)
        const scope = Vue.effectScope()
        const active = scope.run(() => ({
            posts: helpers.useSiteAdminManagementList('posts', { authScope: 'alice' }),
            authors: helpers.useSiteAdminManagementList('authors', { authScope: 'alice' }),
            bob: helpers.useSiteAdminManagementList('posts', { authScope: 'bob' }),
            entry: helpers.useSiteAdminManagementEntry('posts', 'one', { authScope: 'alice' }),
            other: helpers.useSiteAdminManagementEntry('posts', 'two', { authScope: 'alice' }),
            batch: helpers.useSiteAdminBatch({ posts: { list: 'posts' }, authors: { list: 'authors' } }),
        }))!
        await flush()
        expect(
            (active.posts.data.value as { items: Array<{ data: { image: { url: string } } }> }).items[0]?.data.image
                .url,
        ).toBe('http://site.test/manage/assets/asset/content')
        const before = { ...calls }
        const client = helpers.createNuxtSiteAdminManagementClient(
            { origin: 'http://site.test', basePath: '/manage', fetch: request },
            Vue.ref('alice'),
        )
        await client.updateEntry('one', { data: { title: 'Saved' }, expectedVersion: 1 })
        expect(calls['GET /manage/entries?model=posts']).toBe((before['GET /manage/entries?model=posts'] ?? 0) + 1)
        expect(calls['GET /manage/entries?model=authors']).toBe(before['GET /manage/entries?model=authors'])
        expect(calls['GET /manage/entries/two']).toBe(before['GET /manage/entries/two'])
        expect(calls['GET /content/posts']).toBe((before['GET /content/posts'] ?? 0) + 1)
        expect(calls['GET /content/authors']).toBe((before['GET /content/authors'] ?? 0) + 1)
        expect((active.bob.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe('v1')
        expect((active.posts.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe(
            'v2',
        )
        const leaving = Vue.effectScope()
        leaving.run(() => helpers.useSiteAdminManagementList('posts', { authScope: 'alice', q: 'inactive' }))
        await flush()
        leaving.stop()
        const inactiveKey = Object.keys(app.payload.data).find((key) => key.includes('inactive'))!
        await client.updateEntry('one', { data: { title: 'Again' }, expectedVersion: 2 })
        expect(inactiveKey in app.payload.data).toBe(false)
        const returning = Vue.effectScope()
        const returned = returning.run(() =>
            helpers.useSiteAdminManagementList('posts', { authScope: 'alice', q: 'inactive' }),
        )!
        await flush()
        expect((returned.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe('v3')
        returning.stop()
        scope.stop()
    })

    it('does not subscribe during invalidation and stops refreshing public entry/batch after unmount', async () => {
        let reads = 0
        const request: typeof fetch = async (input, init) => {
            if (init?.method === 'PATCH') return Response.json({ id: 'one', model: 'posts', slug: 'new', version: 2 })
            reads += 1
            return Response.json({ data: { _siteAdmin: { id: 'one', model: 'posts', slug: 'old' }, title: 'Public' } })
        }
        const { app, helpers, refreshSubscribers } = await nativeEnvironment(request)
        const scope = Vue.effectScope()
        scope.run(() => ({
            entry: helpers.useSiteAdminEntry('posts', 'old'),
            batch: helpers.useSiteAdminBatch({ entry: { entry: 'posts', slugOrId: 'old' } }),
        }))
        await flush()
        const dependencies = () =>
            Object.values(app['_asyncData'] as Record<string, { _deps: number }>).map((value) => value['_deps'])
        expect(dependencies()).toEqual([1, 1])
        expect(refreshSubscribers()).toBe(2)
        const client = helpers.createNuxtSiteAdminManagementClient(
            { origin: 'http://site.test', basePath: '/manage', fetch: request },
            'alice',
        )
        await client.updateEntry('one', { data: {}, expectedVersion: 1 })
        await client.updateEntry('one', { data: {}, expectedVersion: 2 })
        expect(dependencies()).toEqual([1, 1])
        expect(refreshSubscribers()).toBe(2)
        scope.stop()
        await flush()
        expect(dependencies()).toEqual([0, 0])
        expect(refreshSubscribers()).toBe(0)
        const before = reads
        await client.updateEntry('one', { data: {}, expectedVersion: 3 })
        expect(reads).toBe(before)
    })

    it('invalidates renamed entries when native transform/pick removes identity, within the affected model', async () => {
        let version = 1
        const reads: Record<string, number> = {}
        const request: typeof fetch = async (input, init) => {
            if (init?.method === 'PATCH') {
                version += 1
                return Response.json({ id: 'one', model: 'posts', slug: 'new', version })
            }
            const path = new URL(String(input)).pathname
            reads[path] = (reads[path] ?? 0) + 1
            return Response.json({
                data: {
                    _siteAdmin: { id: 'one', model: path.includes('authors') ? 'authors' : 'posts', slug: 'old' },
                    title: 'v' + version,
                },
            })
        }
        const { helpers } = await nativeEnvironment(request)
        const scope = Vue.effectScope()
        const active = scope.run(() => ({
            transformed: helpers.useSiteAdminEntry('posts', 'old', {
                transform: (entry: { data: unknown }) => entry.data,
            }),
            picked: helpers.useSiteAdminEntry('posts', 'picked', { pick: ['data'] }),
            authors: helpers.useSiteAdminEntry('authors', 'old', {
                transform: (entry: { data: unknown }) => entry.data,
            }),
            batch: helpers.useSiteAdminBatch(
                { entry: { entry: 'posts', slugOrId: 'batch-old' } },
                {
                    transform: (batch: { entry: { data: { data: unknown } } }) => ({
                        entry: { data: batch.entry.data.data },
                    }),
                },
            ),
        }))!
        await flush()
        const client = helpers.createNuxtSiteAdminManagementClient(
            { origin: 'http://site.test', basePath: '/manage', fetch: request },
            'alice',
        )
        await client.updateEntry('one', { data: {}, expectedVersion: 1 })
        expect(reads['/content/posts/old']).toBe(2)
        expect(reads['/content/posts/picked']).toBe(2)
        expect(reads['/content/posts/batch-old']).toBe(2)
        expect(reads['/content/authors/old']).toBe(1)
        expect((active.transformed.data.value as { title: string }).title).toBe('v2')
        scope.stop()
    })

    it('documents native public enumeration limits for serialize:false and app-owned getCachedData', async () => {
        let reads = 0
        const request: typeof fetch = async (input, init) => {
            if (init?.method === 'PATCH') return Response.json({ id: 'one', model: 'posts', version: 2 })
            if (String(input).endsWith('/models')) return Response.json(modelDescriptor)
            reads += 1
            return Response.json({ items: [], total: 0, limit: 20, offset: 0 })
        }
        const { app, helpers } = await nativeEnvironment(request)
        const scope = Vue.effectScope()
        const local = scope.run(() =>
            helpers.useSiteAdminManagementList('posts', { authScope: 'alice', serialize: false }),
        )!
        await flush()
        expect(Object.keys(app.payload.data)).toEqual([])
        const client = helpers.createNuxtSiteAdminManagementClient(
            { origin: 'http://site.test', basePath: '/manage', fetch: request },
            Vue.ref('alice'),
        )
        await client.updateEntry('one', { data: {}, expectedVersion: 1 })
        expect(reads).toBe(1)
        await local.refresh()
        expect(reads).toBe(2)
        expect(Object.keys(app.payload.data)).toEqual([])
        const cached = { items: [{ data: { title: 'App cache' } }], total: 1 }
        const ownCache = scope.run(() =>
            helpers.useSiteAdminManagementList('posts', {
                authScope: 'alice',
                q: 'own-cache',
                getCachedData: () => cached,
            }),
        )!
        await flush()
        await client.updateEntry('one', { data: {}, expectedVersion: 2 })
        expect(ownCache.data.value).toBe(cached)
        await ownCache.refresh({ cachedData: undefined })
        expect(ownCache.data.value).not.toBe(cached)
        expect(reads).toBe(3)
        scope.stop()
    })
})
