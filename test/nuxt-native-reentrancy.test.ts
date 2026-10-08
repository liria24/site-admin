import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createError } from 'h3'
import { expect, it } from 'vitest'
import * as Vue from 'vue'
import { nuxt46Checksum, nuxt46Compatibility, nuxt46SourceVariants } from './nuxt-compatibility'

interface Value {
    slug?: string
    locale?: string
    cache?: string
    value?: number
}
interface Entry {
    data: Vue.Ref<Value | undefined>
    status: Vue.Ref<string>
    error: Vue.Ref<{ message: string } | undefined>
    _deps: number
    _init: boolean
    _initialCachedData?: Value
}
interface State extends PromiseLike<unknown> {
    data: Entry['data']
    status: Entry['status']
    error: Entry['error']
    refresh(): Promise<unknown>
    execute(): Promise<unknown>
    clear(): void
}
interface Options {
    dedupe?: 'defer'
    watch?: Vue.Ref<unknown>[]
    lazy?: boolean
    getCachedData?: (key: string) => Value | undefined
}
type Handler = (_app: unknown, options: { signal: AbortSignal }) => Promise<Value>
type UseNative = (key: string | (() => string), handler: Handler, options?: Options) => State
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const nuxtRoot = dirname(requireNuxt.resolve('nuxt/package.json'))
const installed = await readFile(join(nuxtRoot, 'dist/app/composables/asyncData.js'), 'utf8')
const variants = await nuxt46SourceVariants(installed)
const plain = (source: string) => source.replace(/^import .*$/gmu, '').replace(/^export .*$/gmu, '')
const debounceSource = plain(await readFile(join(nuxtRoot, 'dist/app/utils/debounce-tick.js'), 'utf8'))
const debounceTick = new Function('queuePostFlushCb', `${debounceSource}; return debounceTick`)(
    Vue.queuePostFlushCb,
) as unknown
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const create = (source: string) => {
    const hooks = new Set<object>()
    const app = {
        _asyncData: Vue.shallowReactive<Record<string, Entry>>({}),
        _asyncDataPromises: {},
        payload: {
            data: Vue.shallowReactive<Record<string, Value>>({}),
            _errors: Vue.shallowReactive<Record<string, unknown>>({}),
            serverRendered: true,
        },
        static: { data: {} },
        isHydrating: true,
        hook(name: string, callback: unknown) {
            const item = { name, callback }
            hooks.add(item)
            return () => hooks.delete(item)
        },
    }
    const environment = {
        ...Object.fromEntries(Object.entries(Vue).filter(([name]) => /^[a-zA-Z_$][a-zA-Z_$0-9]*$/u.test(name))),
        useNuxtApp: () => app,
        createError,
        debounceTick,
        asyncDataDefaults: { deep: false },
        granularCachedData: true,
        pendingWhenIdle: false,
        purgeCachedData: true,
        stripNeverHydratedData: false,
        tracingChannelNuxt: false,
        vapor: false,
        clientOnlySymbol: Symbol('client-only'),
    }
    const native = plain(source)
        .replace(/^const createUseAsyncData =.*?^\}\);/gmsu, '')
        .replaceAll('import.meta.client', 'true')
        .replaceAll('import.meta.server', 'false')
        .replaceAll('import.meta.dev', 'false')
        .replaceAll('import.meta.prerender', 'false')
    const initialize = new Function(...Object.keys(environment), `${native}; return useAsyncData`) as (
        ...dependencies: unknown[]
    ) => UseNative
    return { app, hooks, scope: Vue.effectScope(), use: initialize(...Object.values(environment)) }
}

it('runs the installed reviewed patch and retains an exact unchanged original negative control', () => {
    expect(nuxt46Checksum(installed)).toBe(nuxt46Compatibility.patchedSha)
    expect(nuxt46Checksum(variants.original)).toBe(nuxt46Compatibility.originalSha)
})

it.each(['original', 'patched'] as const)(
    'preserves native shared-key ownership after an ordinary error read (%s)',
    async (kind) => {
        const runtime = create(variants[kind]),
            { app, use, scope, hooks } = runtime
        const slug = Vue.ref('ssr'),
            locale = Vue.ref('ja'),
            trigger = Vue.ref(0)
        const key = () => JSON.stringify([slug.value, locale.value])
        app.payload.data[key()] = { slug: 'ssr', locale: 'ja' }
        const calls: Array<{ slug: string; locale: string; signal: AbortSignal }> = []
        const handler: Handler = async (_app, { signal }) => {
            const value = { slug: slug.value, locale: locale.value }
            calls.push({ ...value, signal })
            await delay(value.slug === 'slow' ? 40 : 1)
            signal.throwIfAborted()
            if (value.slug === 'error') throw new Error('Synthetic failure')
            return value
        }
        const entry = scope.run(() => use(key, handler, { dedupe: 'defer', watch: [locale, trigger] }))!
        const duplicate = scope.run(() => use(key, handler, { dedupe: 'defer' }))!
        try {
            await Promise.all([entry, duplicate])
            app.isHydrating = false
            // This supported public error read, without an artificial observer, is the original browser trigger.
            void entry.error.value
            slug.value = 'slow'
            await Vue.nextTick()
            await delay(5)
            slug.value = 'fast'
            await Vue.nextTick()
            await delay(60)
            if (kind === 'original') {
                expect(entry.status.value).toBe('idle')
                expect(entry.data.value?.slug).toBe('ssr')
                expect(app['_asyncData'][key()]!['_deps']).toBe(1)
                expect(calls.every((call) => !call.signal.aborted)).toBe(true)
                return
            }
            expect(entry.status.value).toBe('success')
            expect(entry.data.value?.slug).toBe('fast')
            expect(app['_asyncData'][key()]!['_deps']).toBe(2)
            expect(duplicate.data.value).toBe(entry.data.value)
            expect(calls.find((call) => call.slug === 'slow')?.signal.aborted).toBe(true)
            expect(hooks.size).toBe(1)
            locale.value = 'en'
            await expect.poll(() => entry.data.value?.locale, { timeout: 500, interval: 5 }).toBe('en')
            expect(calls.filter((call) => call.slug === 'fast' && call.locale === 'en')).toHaveLength(1)
            const before = calls.length
            await entry.refresh()
            expect(calls).toHaveLength(before + 1)
            entry.clear()
            expect(entry.data.value).toBeUndefined()
            expect(entry.status.value).toBe('idle')
            expect(entry.error.value).toBeUndefined()
            await entry.execute()
            expect(entry.data.value?.slug).toBe('fast')
            slug.value = 'error'
            await expect.poll(() => entry.status.value, { timeout: 500, interval: 5 }).toBe('error')
            expect(entry.error.value?.message).toBe('Synthetic failure')
            expect(entry.data.value).toBeUndefined()
            expect(app['_asyncData'][key()]!['_deps']).toBe(2)
            expect(hooks.size).toBe(1)
        } finally {
            scope.stop()
            expect(hooks.size).toBe(kind === 'original' ? 2 : 0)
        }
    },
)

it.each(['original', 'patched'] as const)('disposes losing initial-construction hooks (%s)', async (kind) => {
    const { app, use, scope, hooks } = create(variants[kind])
    app.isHydrating = false
    const handler: Handler = async () => ({ value: 1 })
    let sibling: State | undefined,
        creating = false
    scope.run(() =>
        Vue.watch(
            () => Object.keys(app.payload['_errors']),
            () => {
                if (!creating) {
                    creating = true
                    sibling = scope.run(() => use('initial', handler, { dedupe: 'defer' }))
                }
            },
            { flush: 'sync' },
        ),
    )
    const first = scope.run(() => use('initial', handler, { dedupe: 'defer' }))!
    try {
        await Promise.all([first, sibling])
        expect(app['_asyncData'].initial!['_deps']).toBe(kind === 'patched' ? 2 : 1)
        expect(first.status.value).toBe(kind === 'patched' ? 'success' : 'idle')
        expect(hooks.size).toBe(kind === 'patched' ? 1 : 2)
        if (kind === 'patched') expect(first.data.value).toBe(sibling?.data.value)
    } finally {
        scope.stop()
        if (kind === 'patched') expect(hooks.size).toBe(0)
    }
})

const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}),
    createComment: () => ({}),
    createText: () => ({}),
    insert() {},
    remove() {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp() {},
    setElementText() {},
    setText() {},
})
it.each(['key', 'lazy initial'] as const)(
    'adopts the winning custom cache without redundant fetches (%s)',
    async (kind) => {
        const { app, use, scope, hooks } = create(installed)
        app.isHydrating = false
        const slug = Vue.ref(kind === 'key' ? 'initial' : 'cached'),
            key = () => slug.value
        const winner = { slug: 'cached', cache: 'B' },
            loser = { slug: 'cached', cache: 'A' },
            seed = { slug: 'initial', cache: 'seed' }
        // Pure, consistent lookup: construction inserts the error slot between the two cache reads.
        const getCachedData = (name: string) =>
            name === 'initial' ? seed : Object.hasOwn(app.payload['_errors'], name) ? winner : loser
        let requests = 0,
            entry: State,
            duplicate: State | undefined,
            creating = false
        const handler: Handler = async () => {
            requests++
            return { slug: 'network' }
        }
        const options: Options = { dedupe: 'defer', getCachedData, ...(kind === 'lazy initial' ? { lazy: true } : {}) }
        let component: ReturnType<typeof renderer.createApp> | undefined
        if (kind === 'lazy initial') {
            scope.run(() =>
                Vue.watch(
                    () => Object.keys(app.payload['_errors']),
                    () => {
                        if (!creating) {
                            creating = true
                            duplicate = scope.run(() => use(key, handler, { ...options }))
                        }
                    },
                    { flush: 'sync' },
                ),
            )
            component = renderer.createApp({
                setup() {
                    entry = scope.run(() => use(key, handler, { ...options }))!
                    return () => Vue.h('div')
                },
            })
            component.mount({})
        } else {
            entry = scope.run(() => use(key, handler, { ...options }))!
            duplicate = scope.run(() => use(key, handler, { ...options }))
        }
        try {
            await Promise.all([entry!, duplicate])
            void entry!.error.value
            if (kind === 'key') {
                slug.value = 'cached'
                await Vue.nextTick()
            }
            expect(entry!.data.value).toBe(winner)
            expect(duplicate?.data.value).toBe(winner)
            expect(app['_asyncData'].cached!['_initialCachedData']).toBe(winner)
            expect(requests).toBe(0)
            expect(app['_asyncData'].cached!['_deps']).toBe(2)
            expect(hooks.size).toBe(1)
        } finally {
            component?.unmount()
            scope.stop()
            expect(hooks.size).toBe(0)
        }
    },
)

it('publishes cached metadata coherently before the reactive table notifies observers', async () => {
    const { app, use, scope, hooks } = create(installed)
    app.isHydrating = false
    const cached = { value: 1 },
        seen: Array<Value | undefined> = []
    scope.run(() =>
        Vue.watch(
            () => app['_asyncData'].coherent?.['_initialCachedData'],
            (value) => seen.push(value),
            { flush: 'sync' },
        ),
    )
    try {
        const entry = scope.run(() =>
            use(
                'coherent',
                async () => {
                    throw new Error('Cache hit must not fetch')
                },
                { getCachedData: () => cached },
            ),
        )!
        await entry
        expect(seen).toEqual([cached])
        expect(entry.data.value).toBe(cached)
    } finally {
        scope.stop()
        expect(hooks.size).toBe(0)
    }
})
