import { createSiteAdminDescriptor } from '../packages/site-admin/src/descriptor'
import {
    generatedRuntimeSource,
    nativeNuxtDependencies,
    nativeNuxtHash,
    nativeRuntimeSource,
    readNuxtSource,
} from './nuxt-native-runtime'
import { modelEntry as modelRecord } from './model-fixture'
import { createError } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
    createSiteAdminClient,
    createSiteAdminManagementClient,
    presentSiteAdminData,
    SiteAdminClientError,
    type SiteAdminManagementClient,
} from '../packages/site-admin/src/client'
import { defineSiteAdminConfig, image, text } from '../packages/site-admin/src'
import { siteAdminNuxtClientTemplate } from '../packages/site-admin/src/nuxt/client-templates'
import { useEntryForm } from '../packages/site-admin/src/form'
import { createSiteAdminModel, siteAdminModelError, type SiteAdminModel } from '../packages/site-admin/src/model'

interface State {
    data: Vue.Ref<unknown>
    status: Vue.Ref<string>
    error: Vue.Ref<unknown>
    execute(options?: { signal?: AbortSignal; dedupe?: 'cancel' | 'defer' }): Promise<void>
    clear(): void
    refresh(options?: { cachedData?: unknown; signal?: AbortSignal; dedupe?: 'cancel' | 'defer' }): Promise<void>
}
interface Helpers {
    useAdminForm(
        model: string,
        options?: Record<string, unknown>,
    ): Promise<
        ReturnType<typeof useEntryForm<Record<string, unknown>>> & {
            status: State['status']
            refresh: State['refresh']
        }
    >
    siteAdminManagementKey(
        connection: import('../packages/site-admin/src/client').SiteAdminManagementClientOptions,
        scope: string,
        operation: string,
        model: string | null,
        identity: unknown,
        locale?: string,
    ): string
    siteAdminManagementClientOptions(): import('../packages/site-admin/src/client').SiteAdminManagementClientOptions
    useAi(name: string, options: Record<string, unknown>): State & Promise<State>
    modelList(model: string, options?: Record<string, unknown>): State
    modelEntry(model: string, id: Vue.MaybeRefOrGetter<string>, options?: Record<string, unknown>): State
    publicList(model: string, options?: Record<string, unknown>): State
    publicEntry(model: string, id: string, options?: Record<string, unknown>): State
    publicBatch(requests: Record<string, unknown>, options?: Record<string, unknown>): State
    useSiteAdminManagementClient(): SiteAdminManagementClient<Record<string, Record<string, unknown>>>
    createNuxtSiteAdminManagementClient(
        connection: { origin: string; basePath: string; fetch: typeof fetch; credentials?: RequestCredentials },
        auth: Vue.MaybeRefOrGetter<string>,
    ): SiteAdminManagementClient<Record<string, Record<string, unknown>>>
}

const nativeEnvironment = async (
    request: typeof fetch,
    { i18n = false, aiActions = false, serverFetch = false, serverRuntime = false } = {},
) => {
    const native = nativeRuntimeSource(await readNuxtSource('composables/asyncData.js'), {
        serverRuntime,
        asyncData: true,
    })
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
        $i18n: { locale: Vue.ref('ja') },
        _asyncData: Vue.shallowReactive({}),
        _asyncDataPromises: {},
        payload: {
            data: Vue.shallowReactive({} as Record<string, unknown>),
            _errors: Vue.shallowReactive({}),
            serverRendered: serverRuntime,
        },
        static: { data: {} as Record<string, unknown> },
        isHydrating: false,
        hook,
        hooks: {
            callHookParallel: async (name: string, ...args: unknown[]) => {
                await Promise.all([...(hooks.get(name) ?? [])].map((callback) => callback(...args)))
            },
        },
        callHook: async () => {},
        runWithContext: <Value>(callback: () => Value): Value => callback(),
    }
    const nativeDependencies = {
        ...(await nativeNuxtDependencies(app)),
        onNuxtReady: (callback: () => void) => callback(),
        toArray: (value: unknown) => (Array.isArray(value) ? value : [value]),
        defineKeyedFunctionFactory: (options: { factory: unknown }) => options.factory,
        hashKey: await nativeNuxtHash(),
        isPlainObject: (value: unknown) => Object.prototype.toString.call(value) === '[object Object]',
        alwaysRunFetchOnKeyChange: false,
        fetchDefaults: {},
        routeTypedFetch: false,
        $fetch: async (url: string, options: RequestInit) => {
            const response = await request(new URL(url, 'http://site.test'), {
                ...options,
                body: JSON.stringify(options.body),
            })
            if (!response.ok) throw createError({ statusCode: response.status, data: await response.json() })
            return response.json()
        },
    }
    const fetchSource = nativeRuntimeSource(await readNuxtSource('composables/fetch.js'), { serverRuntime })
    const addonsSource = nativeRuntimeSource(await readNuxtSource('composables/addons.js'), { serverRuntime })
    const runtime = new Function(
        ...Object.keys(nativeDependencies),
        `${native}\n${addonsSource}\n${fetchSource}; return { useAsyncData, clearNuxtData, refreshNuxtData, useNuxtData, createUseFetch, defineUseFetchAddon }`,
    )(...Object.values(nativeDependencies)) as Record<string, unknown>
    const generated = generatedRuntimeSource(
        siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage', i18n, aiActions }),
        { serverFetch, asyncData: true },
    )
    let managementFactories = 0
    let requestFetches = 0
    const states = new Map<string, Vue.Ref<unknown>>()
    const dependencies = {
        useEntryForm,
        createSiteAdminModel,
        siteAdminModelError,
        useRoute: () => ({ path: '/' }),
        useState: (key: string, initialize: () => unknown) => {
            if (!states.has(key)) states.set(key, Vue.ref(initialize()))
            return states.get(key)!
        },
        ...nativeDependencies,
        ...runtime,
        siteAdminAsyncData: runtime.useAsyncData,
        createSiteAdminClient,
        createSiteAdminManagementClient: (...args: Parameters<typeof createSiteAdminManagementClient>) => {
            managementFactories += 1
            return createSiteAdminManagementClient(...args)
        },
        presentSiteAdminData,
        SiteAdminClientError,
        useNuxtApp: () => app,
        useRequestURL: () => new URL('http://site.test'),
        useRequestFetch: () => {
            requestFetches += 1
            return async (
                url: string,
                options: RequestInit & { onResponse: (context: { response: Response }) => void },
            ) => {
                const response = await request(new URL(url, 'http://site.test'), options)
                options.onResponse({ response })
                return response
            }
        },
        globalThis: { fetch: request },
    }
    const helpers = new Function(
        ...Object.keys(dependencies),
        `${generated}; return { ${aiActions ? 'useAi,' : ''} useAdminForm, siteAdminAttachAsyncData, modelList: useAdminEntries, modelEntry: useAdminEntry, publicEntry: (model, id, opts) => useContent(model, { ...opts, id }), publicList: useContent, publicBatch: useContent, createNuxtSiteAdminManagementClient, siteAdminManagementClientOptions, useSiteAdminModels, siteAdminReadModels, siteAdminManagementKey, useSiteAdminAuthScope }`,
    )(...Object.values(dependencies)) as Helpers
    return {
        app,
        helpers,
        setRouteResult: (value: unknown) => {
            const route = states.get('site-admin-route')
            if (route) route.value = value
            else states.set('site-admin-route', Vue.ref(value))
        },
        refreshSubscribers: () => hooks.get('app:data:refresh')?.size ?? 0,
        managementFactories: () => managementFactories,
        requestFetches: () => requestFetches,
    }
}
const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Vue.nextTick()
}
const settles = async (pending: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            pending.then(() => true),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), 100)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}
const cancelledSignals = [
    ['AbortSignal.abort()', () => AbortSignal.abort()],
    [
        'an already-aborted controller',
        () => {
            const controller = new AbortController()
            controller.abort()
            return controller.signal
        },
    ],
    ['a string reason', () => AbortSignal.abort('Cancelled')],
    ['a custom non-Error reason', () => AbortSignal.abort({ cancelled: true })],
] as const
describe('native createUseFetch AI actions', () => {
    describe.each(['execute', 'refresh'] as const)('%s cancellation', (method) => {
        it.each(cancelledSignals)(
            'settles %s before execution and permits a subsequent defer retry',
            async (_, signal) => {
                let calls = 0
                const { helpers } = await nativeEnvironment(
                    async () => {
                        calls++
                        return Response.json('Retried')
                    },
                    { aiActions: true },
                )
                const scope = Vue.effectScope()
                // Exercise extensions on the awaited instance, as used by async component setup.
                const state = await scope.run(() =>
                    helpers.useAi('plain', { input: { content: 'A' }, immediate: false }),
                )!
                try {
                    await state.execute()
                    expect(state.status.value).toBe('success')
                    expect(await settles(state[method]({ signal: signal() }))).toBe(true)
                    expect(state.status.value).toBe('idle')
                    expect(state.error.value).toBeUndefined()
                    expect(state.data.value).toBeUndefined()
                    expect(calls).toBe(1)
                    expect(await settles(state.execute())).toBe(true)
                    expect(state.status.value).toBe('success')
                    expect(calls).toBe(2)
                } finally {
                    state.clear()
                    scope.stop()
                }
            },
        )
    })
    it('does not invoke transport for pre-aborted initial execution or interrupt a healthy deferred request', async () => {
        let calls = 0
        let complete!: () => void
        let transport: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                transport = init?.signal ?? undefined
                await new Promise<void>((resolve) => {
                    complete = resolve
                })
                return Response.json('Completed')
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        // Also exercise extensions on the unawaited native composable return.
        const state = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        try {
            expect(await settles(state.execute({ signal: AbortSignal.abort() }))).toBe(true)
            expect(state.status.value).toBe('idle')
            expect(calls).toBe(0)
            const first = state.execute()
            expect(await settles(state.execute({ signal: AbortSignal.abort('Cancelled') }))).toBe(true)
            expect(state.status.value).toBe('pending')
            expect(transport?.aborted).toBe(false)
            expect(calls).toBe(1)
            complete()
            expect(await settles(first)).toBe(true)
            expect(state.data.value).toBe('Completed')
        } finally {
            complete?.()
            state.clear()
            scope.stop()
        }
    })
    it.each([
        ['default AbortError', undefined, 'idle'],
        ['explicit AbortError', new DOMException('Cancelled', 'AbortError'), 'idle'],
        ['string reason', 'Cancelled', 'idle'],
        ['custom non-Error reason', { cancelled: true }, 'idle'],
        ['custom Error reason', new Error('Stopped'), 'error'],
    ] as const)('settles in-flight %s, aborts transport and permits retry', async (_description, reason, status) => {
        let calls = 0
        let transport: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                if (calls === 1) {
                    transport = init?.signal ?? undefined
                    await new Promise<void>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
                    })
                }
                return Response.json('Retried')
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = await scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        try {
            const controller = new AbortController()
            const pending = state.execute({ signal: controller.signal })
            controller.abort(reason)
            expect(transport?.aborted).toBe(true)
            expect(await settles(pending)).toBe(true)
            expect(state.status.value).toBe(status)
            if (status === 'idle') expect(state.error.value).toBeUndefined()
            else expect(state.error.value).toMatchObject({ message: 'Stopped' })
            expect(await settles(state.execute())).toBe(true)
            expect(calls).toBe(2)
            expect(state.data.value).toBe('Retried')
            expect(state.status.value).toBe('success')
        } finally {
            state.clear()
            scope.stop()
        }
    })
    it('settles synchronous abort before middleware begins and allows retry', async () => {
        let calls = 0
        const { helpers } = await nativeEnvironment(
            async () => {
                calls++
                return Response.json('Retried')
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = await scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        const controller = new AbortController()
        const stop = Vue.watch(
            state.status,
            (status) => {
                if (status === 'pending') controller.abort('Cancelled')
            },
            { flush: 'sync' },
        )
        try {
            expect(await settles(state.execute({ signal: controller.signal }))).toBe(true)
            expect(state.status.value).toBe('idle')
            expect(calls).toBe(0)
            stop()
            expect(await settles(state.execute())).toBe(true)
            expect(calls).toBe(1)
            expect(state.status.value).toBe('success')
        } finally {
            stop()
            state.clear()
            scope.stop()
        }
    })
    it('retains native timeout and pre-aborted Error state and permits retry', async () => {
        let calls = 0
        let transport: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                if (calls === 1) {
                    transport = init?.signal ?? undefined
                    await new Promise<void>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
                    })
                }
                return Response.json('Retried')
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = await scope.run(() =>
            helpers.useAi('plain', { input: { content: 'A' }, immediate: false, timeout: 5 }),
        )!
        try {
            expect(await settles(state.execute({ signal: AbortSignal.abort(new Error('Stopped')) }))).toBe(true)
            expect(calls).toBe(0)
            expect(state.status.value).toBe('error')
            expect(state.error.value).toMatchObject({ message: 'Stopped' })
            expect(await settles(state.execute())).toBe(true)
            expect(transport?.aborted).toBe(true)
            expect(state.status.value).toBe('error')
            expect(state.error.value).toMatchObject({ cause: { name: 'TimeoutError' } })
            expect(await settles(state.execute())).toBe(true)
            expect(calls).toBe(2)
            expect(state.status.value).toBe('success')
        } finally {
            state.clear()
            scope.stop()
        }
    })
    it('executes only explicitly with fixed POST/watch/retry and snapshots reactive input', async () => {
        const bodies: unknown[] = []
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                bodies.push(JSON.parse(String(init?.body)))
                expect(init?.method?.toLowerCase()).toBe('post')
                return Response.json({ content: 'Corrected' })
            },
            { aiActions: true },
        )
        const input = Vue.ref({ content: 'First' })
        const scope = Vue.effectScope()
        const state = scope.run(() =>
            helpers.useAi('proofread', { input, immediate: false, method: 'GET', retry: 3, watch: true }),
        )!
        await state
        input.value.content = 'Second'
        await flush()
        expect(bodies).toHaveLength(0)
        const pending = state.execute()
        input.value.content = 'Third'
        await pending
        expect(bodies).toEqual([{ input: { content: 'Second' } }])
        await flush()
        expect(bodies).toHaveLength(1)
        await state.execute()
        expect(state.data.value).toEqual({ content: 'Corrected' })
        scope.stop()
    })
    it('isolates different inputs and auth scopes, hydrates without inference twice', async () => {
        let calls = 0
        const { app, helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                return Response.json(JSON.parse(String(init?.body)).input.content)
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const auth = Vue.ref('alice')
        const a = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, authScope: auth }))!
        const b = scope.run(() => helpers.useAi('plain', { input: { content: 'B' }, authScope: auth }))!
        await Promise.all([a, b])
        expect(a.data.value).toBe('A')
        expect(b.data.value).toBe('B')
        expect(calls).toBe(2)
        app.isHydrating = true
        app.payload.serverRendered = true
        const hydrated = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, authScope: 'alice' }))!
        await hydrated
        expect(hydrated.data.value).toBe('A')
        expect(calls).toBe(2)
        app.isHydrating = false
        auth.value = 'bob'
        await flush()
        expect(a.data.value).toBeUndefined()
        expect(calls).toBe(2)
        await a.execute()
        expect(calls).toBe(3)
        scope.stop()
    })
    it('keeps failures in native error/status and supports cancellation and concurrent dedupe', async () => {
        let calls = 0
        let complete!: () => void
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                await new Promise<void>((resolve, reject) => {
                    complete = resolve
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
                })
                return Response.json({ error: { code: 'SITE_ADMIN_AI_FAILED' } }, { status: 502 })
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        const first = state.execute()
        const duplicate = state.execute()
        expect(calls).toBe(1)
        complete()
        await Promise.all([first, duplicate])
        expect(state.status.value).toBe('error')
        expect(state.error.value).toMatchObject({ statusCode: 502 })
        const controller = new AbortController()
        const cancelled = state.execute({ signal: controller.signal })
        controller.abort(new DOMException('Cancelled', 'AbortError'))
        await cancelled
        expect(state.status.value).toBe('idle')
        expect(state.error.value).toBeUndefined()
        scope.stop()
    })
})
const modelDescriptor = createSiteAdminDescriptor(
    defineSiteAdminConfig({
        models: {
            posts: { fields: { slug: text(), title: text({ required: true }), image: image() } },
            authors: { fields: { slug: text(), title: text({ required: true }) } },
        },
    }),
)

describe('native management AsyncData and mutation invalidation', () => {
    it('fills a form created before the awaited entry during SSR', async () => {
        const { helpers } = await nativeEnvironment(
            async (input) => {
                const path = new URL(String(input)).pathname
                return Response.json(
                    path === '/manage/models' ? modelDescriptor : modelRecord('one', 3, { title: 'Loaded during SSR' }),
                )
            },
            { serverRuntime: true },
        )
        const html = await renderToString(
            Vue.createSSRApp({
                async setup() {
                    const { form, draft } = await helpers.useAdminForm('posts', { id: 'one' })
                    expect(draft.snapshot().version).toBe(3)
                    return () => Vue.h('div', String(form.state.values.title))
                },
            }),
        )
        expect(html).toBe('<div>Loaded during SSR</div>')
    })
    it('initializes a new form after its descriptor and owns unload protection until disposal', async () => {
        const requests: string[] = []
        const { helpers } = await nativeEnvironment(async (input) => {
            const path = new URL(String(input)).pathname
            requests.push(path)
            return Response.json(modelDescriptor)
        })
        const window = new EventTarget()
        vi.stubGlobal('window', window)
        const busy = Vue.ref(false)
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
        let controller: Awaited<ReturnType<Helpers['useAdminForm']>> | undefined
        const app = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                controller = await helpers.useAdminForm('posts', {
                                    defaultValues: { title: 'Default' },
                                    beforeUnload: busy,
                                })
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        const unload = () => {
            const event = new Event('beforeunload', { cancelable: true })
            Object.defineProperty(event, 'returnValue', {
                set: () => {
                    throw new Error('Deprecated returnValue was used')
                },
            })
            window.dispatchEvent(event)
            return event.defaultPrevented
        }
        try {
            app.mount({})
            await flush()
            expect(controller?.form.state.values.title).toBe('Default')
            expect(controller?.draft.isDirty.value).toBe(false)
            expect(requests).toEqual(['/manage/models'])
            expect(unload()).toBe(false)
            controller!.form.setFieldValue('title', 'Edited')
            expect(unload()).toBe(true)
            controller!.form.reset({ ...controller!.form.state.values, title: 'Default' })
            expect(unload()).toBe(false)
            busy.value = true
            expect(unload()).toBe(true)
            app.unmount()
            expect(unload()).toBe(false)
        } finally {
            app.unmount()
            vi.unstubAllGlobals()
        }
    })
    it('defers management entry/list descriptors until execution and shares the started read', async () => {
        const requests: string[] = []
        const { helpers, app } = await nativeEnvironment(async (input) => {
            const path = new URL(String(input)).pathname
            requests.push(path)
            if (path === '/manage/models') return Response.json(modelDescriptor)
            const entry = {
                defaultLocale: '',
                translations: {},
                id: path.split('/').at(-1),
                model: 'posts',
                data: { title: 'Deferred', image: 'asset' },
            }
            return Response.json(path === '/manage/entries' ? { items: [entry], total: 1 } : entry)
        })
        const scope = Vue.effectScope()
        const id = Vue.ref('one')
        const actor = Vue.ref('alice')
        const states = scope.run(() => ({
            entry: helpers.modelEntry('posts', id, { immediate: false, authScope: actor }),
            list: helpers.modelList('posts', { immediate: false, authScope: actor }),
        }))!
        await flush()
        id.value = 'two'
        actor.value = 'bob'
        await flush()
        expect(requests).toEqual([])
        expect(states.entry.status.value).toBe('idle')
        expect(states.list.status.value).toBe('idle')
        expect(Object.values(app.payload.data)).toEqual([])

        await Promise.all([states.entry.execute(), states.list.execute()])
        expect(requests.filter((path) => path === '/manage/models')).toHaveLength(1)
        expect(requests.filter((path) => path !== '/manage/models').sort()).toEqual([
            '/manage/entries',
            '/manage/entries/two',
        ])
        expect(states.entry.status.value).toBe('success')
        expect(states.list.status.value).toBe('success')
        expect((states.entry.data.value as { data: { image: { url: string } } }).data.image.url).toBe(
            'http://site.test/manage/assets/asset/content',
        )
        scope.stop()
    })

    describe.each(['entry', 'list'] as const)('SSR management %s native scheduling', (kind) => {
        it.each([
            ['deferred', { immediate: false }],
            ['client-only', { server: false }],
        ] as const)('keeps %s reads idle without descriptor requests or payload', async (_mode, options) => {
            const requests: string[] = []
            const { helpers, app } = await nativeEnvironment(
                async (input) => {
                    const path = new URL(String(input)).pathname
                    requests.push(path)
                    return Response.json(modelDescriptor)
                },
                { serverFetch: true, serverRuntime: true },
            )
            let state: State | undefined
            const html = await renderToString(
                Vue.createSSRApp({
                    setup() {
                        state =
                            kind === 'entry'
                                ? helpers.modelEntry('posts', 'one', options)
                                : helpers.modelList('posts', options)
                        return () => Vue.h('div', state!.status.value)
                    },
                }),
            )
            expect(html).toBe('<div>idle</div>')
            expect(state?.data.value).toBeUndefined()
            expect(requests).toEqual([])
            expect(app.payload.data).toEqual({})
        })
    })

    it('shares the descriptor after normal SSR entry/list execution starts', async () => {
        const requests: string[] = []
        const environment = await nativeEnvironment(
            async (input) => {
                const path = new URL(String(input)).pathname
                requests.push(path)
                if (path === '/manage/models') return Response.json(modelDescriptor)
                const entry = {
                    defaultLocale: '',
                    translations: {},
                    id: 'one',
                    model: 'posts',
                    data: { title: 'SSR', image: 'asset' },
                }
                return Response.json(path === '/manage/entries' ? { items: [entry], total: 1 } : entry)
            },
            { serverFetch: true, serverRuntime: true },
        )
        const html = await renderToString(
            Vue.createSSRApp({
                setup() {
                    const entry = environment.helpers.modelEntry('posts', 'one')
                    const list = environment.helpers.modelList('posts')
                    return () => Vue.h('div', entry.status.value + ':' + list.status.value)
                },
            }),
        )
        expect(html).toBe('<div>success:success</div>')
        expect(requests.filter((path) => path === '/manage/models')).toHaveLength(1)
        expect(requests.filter((path) => path !== '/manage/models').sort()).toEqual([
            '/manage/entries',
            '/manage/entries/one',
        ])
        expect(environment.requestFetches()).toBe(1)
    })

    it('reuses clients within a request and auth scope, separating transport identity and credentials', async () => {
        const request = async () => Response.json({ items: [], total: 0, limit: 50, offset: 0 })
        const environment = await nativeEnvironment(request)
        const auth = Vue.ref('alice')
        const connection = {
            origin: 'http://site.test',
            basePath: '/manage',
            fetch: request,
            credentials: 'same-origin' as RequestCredentials,
        }
        const a = environment.helpers.createNuxtSiteAdminManagementClient(connection, auth)
        const b = environment.helpers.createNuxtSiteAdminManagementClient({ ...connection }, auth)
        await Promise.all([a.listEntries('posts'), b.listEntries('posts')])
        expect(environment.managementFactories()).toBe(1)
        auth.value = 'bob'
        await a.listEntries('posts')
        expect(environment.managementFactories()).toBe(2)
        connection.credentials = 'omit'
        await a.listEntries('posts')
        expect(environment.managementFactories()).toBe(3)
        connection.credentials = 'same-origin'
        await a.listEntries('posts')
        expect(environment.managementFactories()).toBe(3)
        environment.helpers.createNuxtSiteAdminManagementClient({ ...connection, fetch: async () => request() }, auth)
        expect(environment.managementFactories()).toBe(4)
        const otherRequest = await nativeEnvironment(request)
        otherRequest.helpers.createNuxtSiteAdminManagementClient(connection, auth)
        expect(otherRequest.managementFactories()).toBe(1)
    })

    it('shares one native request-fetch wrapper per SSR app without retaining it across requests', async () => {
        const request = async () => Response.json(modelDescriptor)
        const first = await nativeEnvironment(request, { serverFetch: true })
        const a = first.helpers.siteAdminManagementClientOptions()
        const b = first.helpers.siteAdminManagementClientOptions()
        expect(a.fetch).toBe(b.fetch)
        expect(first.requestFetches()).toBe(1)
        await first.helpers
            .createNuxtSiteAdminManagementClient(
                a as typeof a & { origin: string; basePath: string; fetch: typeof fetch },
                'alice',
            )
            .models()
        const second = await nativeEnvironment(request, { serverFetch: true })
        const c = second.helpers.siteAdminManagementClientOptions()
        expect(c.fetch).not.toBe(a.fetch)
        expect(second.requestFetches()).toBe(1)
    })

    it('shares descriptors across parallel lists/entries and ID switches without aborting another consumer', async () => {
        const descriptorReply = Promise.withResolvers<Response>()
        let models = 0
        let modelSignal: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(async (input, init) => {
            const url = new URL(String(input))
            if (url.pathname.endsWith('/models')) {
                models += 1
                modelSignal = init?.signal ?? undefined
                return descriptorReply.promise
            }
            const id = url.pathname.split('/').at(-1)!
            const record = {
                defaultLocale: '',
                translations: {},
                id,
                model: 'posts',
                locale: '',
                version: 1,
                data: { slug: id, title: id, image: 'asset' },
            }
            return Response.json(
                url.pathname === '/manage/entries' ? { items: [record], total: 1, limit: 50, offset: 0 } : record,
            )
        })
        const scope = Vue.effectScope()
        const id = Vue.ref('one')
        const states = scope.run(() => ({
            list: helpers.modelList('posts', { authScope: 'alice' }),
            entry: helpers.modelEntry('posts', id, { authScope: 'alice' }),
        }))!
        await flush()
        expect(models).toBe(1)
        id.value = 'two'
        await flush()
        expect(modelSignal?.aborted).toBe(false)
        descriptorReply.resolve(Response.json(modelDescriptor))
        await flush()
        expect((states.entry.data.value as { id: string }).id).toBe('two')
        expect(
            (states.list.data.value as { items: Array<{ data: { image: { url: string } } }> }).items[0]?.data.image.url,
        ).toBe('http://site.test/manage/assets/asset/content')
        expect(models).toBe(1)
        scope.stop()
    })

    it('rejects an old auth descriptor reply and loads the new scope without sharing its transport', async () => {
        const oldReply = Promise.withResolvers<Response>()
        const actor = Vue.ref('alice')
        let modelCalls = 0
        let oldSignal: AbortSignal | undefined
        const environment = await nativeEnvironment(async (input, init) => {
            if (String(input).endsWith('/models')) {
                modelCalls += 1
                if (modelCalls === 1) {
                    oldSignal = init?.signal ?? undefined
                    return oldReply.promise
                }
                return Response.json(modelDescriptor)
            }
            return Response.json({
                items: [
                    { defaultLocale: '', translations: {}, id: 'one', model: 'posts', data: { title: actor.value } },
                ],
                total: 1,
            })
        })
        const scope = Vue.effectScope()
        const state = scope.run(() => environment.helpers.modelList('posts', { authScope: actor }))!
        await flush()
        expect(modelCalls).toBe(1)
        actor.value = 'bob'
        await flush()
        expect(oldSignal?.aborted).toBe(true)
        expect(modelCalls).toBe(2)
        expect(environment.managementFactories()).toBe(2)
        oldReply.resolve(Response.json({ models: {} }))
        await flush()
        expect(state.error.value).toBeUndefined()
        expect((state.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe('bob')
        expect(Object.keys(environment.app.payload.data).every((key) => !key.includes('alice'))).toBe(true)
        scope.stop()
    })

    it.each([401, 403, 404])('preserves descriptor status %s in typed management reads', async (status) => {
        let models = 0
        const { helpers } = await nativeEnvironment(async (input) => {
            if (String(input).endsWith('/models')) {
                models += 1
                return Response.json({ error: { code: 'DESCRIPTOR_FAILED', message: 'Denied' } }, { status })
            }
            return Response.json({ items: [], total: 0, limit: 50, offset: 0 })
        })
        const scope = Vue.effectScope()
        const state = scope.run(() => helpers.modelList('posts'))!
        await flush()
        expect(state.error.value).toMatchObject({ statusCode: status })
        expect(state.data.value).toBeUndefined()
        expect(models).toBe(1)
        scope.stop()
    })
    it('uses reactive i18n defaults for management and public helpers with explicit overrides', async () => {
        const urls: URL[] = []
        const { app, helpers } = await nativeEnvironment(
            async (input) => {
                const url = new URL(String(input))
                urls.push(url)
                if (url.pathname === '/manage/models') return Response.json(modelDescriptor)
                const entry = {
                    defaultLocale: '',
                    translations: {},
                    id: 'one',
                    model: 'posts',
                    locale: url.searchParams.get('locale') ?? '',
                    version: 1,
                    data: { slug: 'one', title: 'Title' },
                }
                if (url.pathname === '/manage/entries')
                    return Response.json({ items: [entry], total: 1, limit: 50, offset: 0 })
                if (url.pathname === '/manage/entries/one') return Response.json(entry)
                return Response.json([
                    { data: { _siteAdmin: { id: 'one', model: 'posts', slug: 'one' }, title: 'Public' } },
                ])
            },
            { i18n: true },
        )
        const scope = Vue.effectScope()
        const explicit = Vue.ref('ja')
        const states = scope.run(() => ({
            list: helpers.modelList('posts'),
            entry: helpers.modelEntry('posts', 'one'),
            localized: helpers.modelList('posts', { locale: explicit }),
            public: helpers.publicList('posts'),
        }))!
        await flush()
        expect((states.entry.data.value as { locale: string }).locale).toBe('')
        expect((states.list.data.value as { items: unknown[] }).items).toHaveLength(1)
        expect(
            urls.filter((url) => url.pathname === '/manage/entries').map((url) => url.searchParams.get('locale')),
        ).toEqual(['ja'])
        expect(urls.find((url) => url.pathname === '/manage/entries/one')?.searchParams.get('locale')).toBeNull()
        expect(urls.find((url) => url.pathname === '/content/posts')?.searchParams.get('locale')).toBe('ja')
        const managementCount = urls.filter((url) => url.pathname.startsWith('/manage/')).length
        app.$i18n.locale.value = 'en'
        await flush()
        expect(urls.filter((url) => url.pathname.startsWith('/manage/')).length).toBeGreaterThan(managementCount)
        expect(
            urls
                .filter((url) => url.pathname === '/content/posts')
                .at(-1)
                ?.searchParams.get('locale'),
        ).toBe('en')
        explicit.value = 'en'
        await flush()
        expect(
            urls
                .filter((url) => url.pathname === '/manage/entries')
                .at(-1)
                ?.searchParams.get('locale'),
        ).toBe('en')
        scope.stop()
    })
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
        app.payload.data['site-admin-management:' + JSON.stringify([...prefix, 'entry', 'posts', 'one', null])] = {
            defaultLocale: '',
            translations: {},
            id: 'one',
            model: 'posts',
            locale: '',
            version: 3,
            data: { slug: 'one', title: 'Hydrated', image: 'asset' },
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
        let controller: ReturnType<typeof useEntryForm<Record<string, unknown>>> | undefined
        const component = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                const [pending, restore] = (
                                    Vue as typeof Vue & {
                                        withAsyncContext: (fn: () => unknown) => [Promise<unknown>, () => void]
                                    }
                                ).withAsyncContext(() =>
                                    helpers.useAdminForm('posts', { id: 'one', authScope: 'alice' }),
                                )
                                const resource = await pending
                                restore()
                                controller = resource as Awaited<ReturnType<Helpers['useAdminForm']>>
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        component.mount({})
        await flush()
        expect(controller?.form.state.values.title).toBe('Hydrated')
        expect(controller?.draft.snapshot().version).toBe(3)
        expect(controller?.draft.isDirty.value).toBe(false)
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
            defaultLocale: '',
            translations: {},
            id: entryId,
            model: 'posts',
            locale: '',
            version: 1,
            data: { slug: entryId, title: actor.value + ' ' + entryId },
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
        let controller: ReturnType<typeof useEntryForm<Record<string, unknown>>> | undefined
        const component = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                const [pending, restore] = (
                                    Vue as typeof Vue & {
                                        withAsyncContext: (fn: () => unknown) => [Promise<unknown>, () => void]
                                    }
                                ).withAsyncContext(() =>
                                    helpers.modelEntry('posts', () => id.value, { authScope: actor }),
                                )
                                const resource = await pending
                                restore()
                                controller = useEntryForm(resource as SiteAdminModel<Record<string, unknown>>)
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
        expect(controller?.draft.snapshot().entryId).toBe('two')
        expect(controller?.form.state.values.title).toBe('alice two')
        id.value = 'one'
        await flush()
        expect(controller?.form.state.values.title).toBe('Unsaved one')
        actor.value = 'bob'
        await flush()
        expect(controller?.form.state.values.title).toBe('bob one')
        expect(controller?.draft.isDirty.value).toBe(false)
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
                version,
                locale: '',
                data: { slug: id, title: 'v' + version, image: 'asset' },
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
            posts: helpers.modelList('posts', { authScope: 'alice' }),
            authors: helpers.modelList('authors', { authScope: 'alice' }),
            bob: helpers.modelList('posts', { authScope: 'bob' }),
            entry: helpers.modelEntry('posts', 'one', { authScope: 'alice' }),
            other: helpers.modelEntry('posts', 'two', { authScope: 'alice' }),
            batch: helpers.publicBatch({ posts: { list: 'posts' }, authors: { list: 'authors' } }),
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
        await client.updateEntry('one', { data: { slug: 'saved', title: 'Saved' }, expectedVersion: 1 })
        expect(calls['GET /manage/entries?model=posts&limit=20&offset=0']).toBe(
            (before['GET /manage/entries?model=posts&limit=20&offset=0'] ?? 0) + 1,
        )
        expect(calls['GET /manage/entries?model=authors&limit=20&offset=0']).toBe(
            before['GET /manage/entries?model=authors&limit=20&offset=0'],
        )
        expect(calls['GET /manage/entries/two']).toBe(before['GET /manage/entries/two'])
        expect(calls['GET /content/posts']).toBe((before['GET /content/posts'] ?? 0) + 1)
        expect(calls['GET /content/authors']).toBe((before['GET /content/authors'] ?? 0) + 1)
        expect((active.bob.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe('v1')
        expect((active.posts.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe(
            'v2',
        )
        const leaving = Vue.effectScope()
        leaving.run(() => helpers.modelList('posts', { authScope: 'alice', q: 'inactive' }))
        await flush()
        leaving.stop()
        const inactiveKey = Object.keys(app.payload.data).find((key) => key.includes('inactive'))!
        await client.updateEntry('one', { data: { slug: 'again', title: 'Again' }, expectedVersion: 2 })
        expect(inactiveKey in app.payload.data).toBe(false)
        const returning = Vue.effectScope()
        const returned = returning.run(() => helpers.modelList('posts', { authScope: 'alice', q: 'inactive' }))!
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
            entry: helpers.publicEntry('posts', 'old'),
            batch: helpers.publicBatch({
                entry: { entry: 'posts', id: 'old' },
                second: { entry: 'posts', id: 'second' },
            }),
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
            transformed: helpers.publicEntry('posts', 'old', {
                transform: (entry: { data: unknown }) => entry.data,
            }),
            picked: helpers.publicEntry('posts', 'picked', { pick: ['data'] }),
            authors: helpers.publicEntry('authors', 'old', {
                transform: (entry: { data: unknown }) => entry.data,
            }),
            batch: helpers.publicBatch(
                { entry: { entry: 'posts', id: 'batch-old' } },
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
})

it('reuses the same-origin route entry before public native transformations', async () => {
    let reads = 0
    const environment = await nativeEnvironment(async () => {
        reads++
        return Response.json({ ...modelRecord('two'), data: { title: 'Fetched' } })
    })
    const raw = { ...modelRecord('one'), data: { title: 'Resolved' } }
    environment.setRouteResult({ kind: 'page', path: '/', origin: 'http://site.test', entry: raw })
    const scope = Vue.effectScope()
    const entry = scope.run(() =>
        environment.helpers.publicEntry('posts', 'one', {
            transform: (value: { data: { title: string } }) => value.data.title,
        }),
    )!
    await entry.execute({ dedupe: 'defer' })
    expect(entry.data.value).toBe('Resolved')
    expect(raw.data.title).toBe('Resolved')
    expect(reads).toBe(0)
    const other = scope.run(() => environment.helpers.publicEntry('posts', 'two'))!
    await other.execute({ dedupe: 'defer' })
    expect(reads).toBe(1)
    scope.stop()
})

it('preserves a management snapshot on refresh failure and corrects a deleted last page', async () => {
    const page = Vue.ref(2)
    let total = 21
    let fail = false
    const environment = await nativeEnvironment(async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/models')) return Response.json(modelDescriptor)
        if (init?.method === 'DELETE') {
            total = 20
            return new Response(null, { status: 204, headers: { 'x-site-admin-model': 'posts' } })
        }
        if (fail)
            return Response.json(
                { error: { code: 'SITE_ADMIN_STORAGE_UNAVAILABLE', message: 'Try later' } },
                { status: 503 },
            )
        const offset = Number(url.searchParams.get('offset'))
        return Response.json({ items: offset >= total ? [] : [modelRecord('one')], total, limit: 20, offset })
    })
    const scope = Vue.effectScope()
    const source = scope.run(() => environment.helpers.modelList('posts', { page }))! as State & {
        remove: (entry: ReturnType<typeof modelRecord>) => Promise<unknown>
    }
    await source.execute({ dedupe: 'defer' })
    fail = true
    await source.refresh()
    expect(source.status.value).toBe('error')
    expect(source.error.value).toMatchObject({ data: { code: 'SITE_ADMIN_STORAGE_UNAVAILABLE' } })
    expect(source.data.value).toMatchObject({ total: 21, items: [{ id: 'one' }] })
    fail = false
    await source.remove(modelRecord('one'))
    expect(page.value).toBe(1)
    expect(source.data.value).toMatchObject({ total: 20, offset: 0 })
    expect(source.status.value).toBe('success')
    scope.stop()
})
