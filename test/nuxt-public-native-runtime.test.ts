import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { createError } from 'h3'
import { expect, it } from 'vitest'
import * as Vue from 'vue'
import type { MaybeRefOrGetter, Ref } from 'vue'

import {
    createSiteAdminClient,
    createSiteAdminManagementClient,
    SiteAdminClientError,
    type PublicEntry,
} from '../packages/site-admin/src/client'
import { siteAdminNuxtClientTemplate } from '../packages/site-admin/src/nuxt/client-templates'

type State<Data> = PromiseLike<unknown> & {
    data: Ref<Data>
    status: Ref<string>
    error: Ref<unknown>
    refresh(): Promise<unknown>
    execute(): Promise<unknown>
    clear(): void
}
interface Helpers {
    entry(
        model: string,
        slug: MaybeRefOrGetter<string>,
        options: { locale: Ref<string>; watch?: Ref<unknown>[]; dedupe: 'defer' },
    ): State<PublicEntry | null | undefined>
    list(model: string, options: { locale: Ref<string> }): State<PublicEntry[] | undefined>
}

interface TestNode {
    text: string
}
const renderer = Vue.createRenderer<TestNode, TestNode>({
    createElement: () => ({ text: '' }),
    createComment: (text) => ({ text }),
    createText: (text) => ({ text }),
    insert: () => {},
    remove: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: () => {},
    setElementText: (node, text) => {
        node.text = text
    },
    setText: (node, text) => {
        node.text = text
    },
})

it.each(['completed', 'during', 'transition'] as const)(
    'keeps generated Entry/List keys reactive with the native runtime and real loopback client transport (%s hydration)',
    async (hydration) => {
        const counts: Record<string, number> = {}
        const observations: Array<{ key: string; aborted: boolean }> = []
        const timers: ReturnType<typeof setTimeout>[] = []
        const server = createServer((request, response) => {
            const url = new URL(request.url!, 'http://localhost')
            const slug = url.pathname.split('/')[3] ?? 'list'
            const locale = url.searchParams.get('locale') ?? ''
            const key = `${slug}:${locale}`
            counts[key] = (counts[key] ?? 0) + 1
            const observation = { key, aborted: false }
            observations.push(observation)
            response.once('close', () => {
                if (!response.writableEnded) observation.aborted = true
            })
            const document = {
                data: {
                    _siteAdmin: { id: slug, model: 'posts', slug, locale },
                    title: key,
                    body: { nodes: [['p', {}, 'Body']], frontmatter: {}, meta: {} },
                },
            }
            const finish = () => {
                if (response.destroyed) return
                response.setHeader('content-type', 'application/json')
                response.end(JSON.stringify(slug === 'list' ? [document] : document))
            }
            if (slug === 'slow') timers.push(setTimeout(finish, 100))
            else finish()
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Loopback server did not open a TCP port.')
        const origin = `http://127.0.0.1:${address.port}`
        let componentApp: ReturnType<typeof renderer.createApp> | undefined
        try {
            const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
            const nuxtRoot = dirname(requireNuxt.resolve('nuxt/package.json'))
            const script = (source: string) => source.replace(/^import .*$/gmu, '').replace(/^export .*$/gmu, '')
            // Execute the shipped public useAsyncData implementation with a supplied Nuxt app/config environment.
            // This covers runtime key/watch semantics; actual factory macro transformation stays in the packed consumer gate.
            const nativeSource = script(await readFile(join(nuxtRoot, 'dist/app/composables/asyncData.js'), 'utf8'))
                .replace(/^const createUseAsyncData =.*?^\}\);/gmsu, '')
                .replaceAll('import.meta.client', 'true')
                .replaceAll('import.meta.server', 'false')
                .replaceAll('import.meta.dev', 'false')
                .replaceAll('import.meta.prerender', 'false')
            const debounceSource = script(await readFile(join(nuxtRoot, 'dist/app/utils/debounce-tick.js'), 'utf8'))
            const debounceTick = new Function('queuePostFlushCb', `${debounceSource}; return debounceTick`)(
                Vue.queuePostFlushCb,
            ) as unknown
            const client = createSiteAdminClient({ origin, basePath: '/content' })
            const initial = await client.get('posts', 'ssr', { locale: 'ja' })
            const key = 'site-admin:' + JSON.stringify([origin, '/content', 'entry', 'posts', 'ssr', 'ja'])
            const app = {
                _asyncData: Vue.shallowReactive({}),
                _asyncDataPromises: {},
                payload: {
                    data: Vue.shallowReactive({ [key]: initial }),
                    _errors: Vue.shallowReactive({}),
                    serverRendered: true,
                },
                static: { data: {} },
                hook: () => () => {},
                isHydrating: true,
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
            const nativeAsyncData = new Function(...Object.keys(environment), `${nativeSource}; return useAsyncData`)(
                ...Object.values(environment),
            ) as unknown
            const generated = stripTypeScriptTypes(
                siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/api/_admin', origin }),
            )
                .replace(/^import .*$/gmu, '')
                .replace(/^export const siteAdminAsyncData = createUseAsyncData\(\)\s*$/gmu, '')
                .replace(/^export /gmu, '')
                .replaceAll('import.meta.server', 'false')
            const initialize = new Function(
                'siteAdminAsyncData',
                'createSiteAdminClient',
                'createSiteAdminManagementClient',
                'SiteAdminClientError',
                'computed',
                'toValue',
                `${generated}; return { entry: useSiteAdminEntry, list: useSiteAdminList }`,
            ) as (...dependencies: unknown[]) => Helpers
            const helpers = initialize(
                nativeAsyncData,
                createSiteAdminClient,
                createSiteAdminManagementClient,
                SiteAdminClientError,
                Vue.computed,
                Vue.toValue,
            )
            const slug = Vue.ref('ssr')
            const locale = Vue.ref('ja')
            const trigger = Vue.ref(0)
            let entry!: State<PublicEntry | null | undefined>
            let duplicate!: State<PublicEntry | null | undefined>
            let list!: State<PublicEntry[] | undefined>
            const mounted = Promise.withResolvers<void>()
            const withAsyncContext = (
                Vue as typeof Vue & {
                    withAsyncContext: <Value>(callback: () => Promise<Value>) => [Promise<Value>, () => void]
                }
            ).withAsyncContext
            componentApp = renderer.createApp({
                render: () =>
                    Vue.h(Vue.Suspense, null, {
                        default: () =>
                            Vue.h({
                                async setup() {
                                    entry = helpers.entry('posts', slug, {
                                        locale,
                                        watch: [locale, trigger],
                                        dedupe: 'defer',
                                    })
                                    duplicate = helpers.entry('posts', () => slug.value, { locale, dedupe: 'defer' })
                                    list = helpers.list('posts', { locale })
                                    const initialView = Vue.computed(() =>
                                        JSON.stringify({ entry: entry.data.value, list: list.data.value }),
                                    )
                                    Vue.onMounted(() => mounted.resolve())
                                    const [pending, restore] = withAsyncContext(() =>
                                        Promise.all([entry, duplicate, list]),
                                    )
                                    await pending
                                    restore()
                                    return () => Vue.h('div', initialView.value)
                                },
                            }),
                    }),
            })
            componentApp.mount({ text: '' })
            await mounted.promise
            // An ordinary error read registers the reactive error-map dependency behind the shared-key regression.
            void entry.error.value
            app.isHydrating = hydration !== 'completed'
            expect(counts['ssr:ja']).toBe(1)
            expect(entry.data.value?.data.title).toBe('ssr:ja')
            slug.value = 'slow'
            await expect.poll(() => counts['slow:ja'], { timeout: 1000, interval: 5 }).toBe(1)
            if (hydration === 'transition') app.isHydrating = false
            slug.value = 'fast'
            await expect.poll(() => entry.data.value?.slug, { timeout: 1000, interval: 5 }).toBe('fast')
            await new Promise((resolve) => setTimeout(resolve, 150))
            expect(entry.status.value).toBe('success')
            expect(entry.data.value?.slug).toBe('fast')
            expect(observations.find((item) => item.key === 'slow:ja')?.aborted).toBe(true)
            locale.value = 'en'
            await expect.poll(() => entry.data.value?.locale, { timeout: 1000, interval: 5 }).toBe('en')
            await expect.poll(() => list.data.value?.[0]?.locale, { timeout: 1000, interval: 5 }).toBe('en')
            await Vue.nextTick()
            expect(counts['fast:ja']).toBe(1)
            expect(counts['fast:en']).toBe(1)
            expect(counts['list:en']).toBe(1)
            expect(duplicate.data.value).toBe(entry.data.value)
            app.isHydrating = false
            await entry.refresh()
            expect(counts['fast:en']).toBe(2)
            entry.clear()
            expect(entry.data.value).toBeUndefined()
            expect(entry.status.value).toBe('idle')
            await entry.execute()
            expect(counts['fast:en']).toBe(3)
            expect(entry.data.value?.data.title).toBe('fast:en')
        } finally {
            componentApp?.unmount()
            timers.forEach(clearTimeout)
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    },
)
