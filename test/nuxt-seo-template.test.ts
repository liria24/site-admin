import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, getCurrentScope, nextTick, reactive, ref, toValue, watch, type EffectScope } from 'vue'

import {
    createSiteAdminRouteResolver,
    mergeSiteAdminSeo,
    type SiteAdminRouteRules,
} from '../packages/site-admin/src/seo'
import type { PublicEntrySeo } from '../packages/site-admin/src/server/types'
import { siteAdminNuxtSeoTemplate } from '../packages/site-admin/src/nuxt/client-templates'
import {
    siteAdminNuxtMetadataTemplate,
    siteAdminNuxtRouteTemplate,
} from '../packages/site-admin/src/nuxt/route-templates'

type Input = PublicEntrySeo | null | undefined
interface ServerHead {
    push(input: unknown, options?: { tagPriority?: string }): unknown
    render(): Promise<{ headTags: string }>
}
const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const nativeHead = (await import(pathToFileURL(requireNuxt.resolve('@unhead/vue/server')).href)) as {
    createHead: () => ServerHead
}
const nativeVueHead = (await import(pathToFileURL(requireNuxt.resolve('@unhead/vue')).href)) as {
    useHead: (input: unknown, options: { head: ServerHead; tagPriority?: string }) => unknown
    useSeoMeta: (input: unknown, options: { head: ServerHead; tagPriority?: string }) => unknown
}
const scopes: EffectScope[] = []
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()))

const initialize = (
    ogImage: boolean,
    config: { seo?: PublicEntrySeo; routeRules?: SiteAdminRouteRules } = {},
    head?: ServerHead,
    seo = true,
) => {
    const route = reactive({ path: '/page' })
    const useHead = vi.fn((input: unknown, options: { tagPriority?: string }) =>
        head ? nativeVueHead.useHead(input, { ...options, head }) : undefined,
    )
    const useSeoMeta = vi.fn((input: unknown, options: { tagPriority?: string }) =>
        head ? nativeVueHead.useSeoMeta(input, { ...options, head }) : undefined,
    )
    let inNuxtContext = false
    const contexts: Array<{ nuxt: boolean; scope: EffectScope | undefined }> = []
    const defineOgImage = vi.fn(() => {
        contexts.push({ nuxt: inNuxtContext, scope: getCurrentScope() })
        // Match the actual lazy, high-priority native OG registration instead of assuming call order decides precedence.
        head?.push(
            {
                meta: () => [
                    { name: 'twitter:card', content: 'summary_large_image' },
                    { property: 'og:image', content: 'https://example.test/generated.png' },
                    { name: 'twitter:image', content: 'https://example.test/generated.png' },
                    { property: 'og:image:width', content: 1200 },
                    { property: 'og:image:alt', content: 'Generated' },
                ],
            },
            { tagPriority: 'high' },
        )
        return ['/generated.png']
    })
    const source = siteAdminNuxtSeoTemplate({ ogImage, seo }).replace(/^import .*\n/gmu, '')
    const compiled = stripTypeScriptTypes(source).replace(/^export /gmu, '')
    const create = new Function(
        'useHead',
        'useSeoMeta',
        'useRoute',
        'useRuntimeConfig',
        'useRequestURL',
        'useNuxtApp',
        'defineOgImage',
        'computed',
        'toValue',
        'getCurrentScope',
        'ref',
        'watch',
        'createSiteAdminRouteResolver',
        'mergeSiteAdminSeo',
        `${compiled}\nreturn useSeo`,
    ) as (
        ...dependencies: unknown[]
    ) => (
        input?: Input | ReturnType<typeof ref<Input>> | (() => Input),
        override?: Input | ReturnType<typeof ref<Input>> | (() => Input),
    ) => void
    const scope = effectScope()
    scopes.push(scope)
    const helper = create(
        useHead,
        useSeoMeta,
        () => route,
        () => ({ public: { siteAdmin: config } }),
        () => new URL('https://example.test/page'),
        () => ({
            runWithContext: (callback: () => unknown) => {
                const previous = inNuxtContext
                inNuxtContext = true
                try {
                    return callback()
                } finally {
                    inNuxtContext = previous
                }
            },
        }),
        defineOgImage,
        computed,
        toValue,
        getCurrentScope,
        ref,
        watch,
        createSiteAdminRouteResolver,
        mergeSiteAdminSeo,
    )
    const useSeo = (...args: Parameters<typeof helper>) => scope.run(() => helper(...args))
    const meta = () =>
        Object.fromEntries(
            Object.entries(useSeoMeta.mock.calls.at(-1)![0] as Record<string, unknown>).map(([name, value]) => [
                name,
                typeof value === 'function' ? (value as () => unknown)() : value,
            ]),
        )
    return { useSeo, useHead, useSeoMeta, defineOgImage, route, meta, contexts, scope }
}

describe('generated Nuxt useSeo', () => {
    it('automatic metadata consumes entry.seo through the same reactive defaults/route resolver', async () => {
        const state = ref<{ kind: string; entry: { locale: string; seo: PublicEntrySeo; data: unknown } } | null>(null)
        const result = {
            kind: 'page',
            entry: {
                locale: 'ja',
                seo: { title: 'Entry', description: 'Native summary' },
                data: { body: { nodes: [] } },
            },
        }
        const client = { resolveRoute: vi.fn(async () => result) }
        const middleware = new Function(
            'defineNuxtRouteMiddleware',
            'useState',
            'useSiteAdminClient',
            'navigateTo',
            siteAdminNuxtRouteTemplate({ i18n: false }, { supported: [], strategy: 'no_prefix' })
                .replace(/^import .*\n/gmu, '')
                .replace('export default ', 'return '),
        )(
            (value: unknown) => value,
            () => state,
            () => client,
            vi.fn(),
        ) as (route: { path: string }) => Promise<void>
        await middleware({ path: '/page' })
        expect(client.resolveRoute).toHaveBeenCalledOnce()
        expect(state.value).toEqual(result)
        const helper = initialize(false, {
            seo: { titleTemplate: '%s | Global' },
            routeRules: { '/page': { seo: { robots: 'noindex, follow' } } },
        })
        const plugin = new Function(
            'defineNuxtPlugin',
            'useState',
            'useSeo',
            'useHead',
            siteAdminNuxtMetadataTemplate({ seo: true, ogImage: false, schemaOrg: false })
                .replace(/^import .*\n/gmu, '')
                .replace('export default ', 'return '),
        )(
            (value: unknown) => value,
            () => state,
            helper.useSeo,
            helper.useHead,
        ) as () => void
        helper.scope.run(plugin)
        expect(helper.meta()).toMatchObject({
            title: 'Entry',
            description: 'Native summary',
            robots: 'noindex, follow',
        })
        expect((helper.useHead.mock.calls[0]![0] as () => unknown)()).toMatchObject({ titleTemplate: '%s | Global' })
        state.value!.entry.seo = { title: 'Changed', description: 'Changed summary' }
        expect(helper.meta()).toMatchObject({ title: 'Changed', description: 'Changed summary' })
        state.value = null
        expect(helper.meta().description).toBeUndefined()
    })

    it('keeps SEO head tags disabled when only the OG integration is enabled', () => {
        const { useSeo, meta, useHead } = initialize(true, {}, undefined, false)
        useSeo({ title: 'OG only', description: 'OG description', canonical: '/og', robots: 'noindex' })
        expect(meta()).toMatchObject({ ogTitle: 'OG only', ogDescription: 'OG description' })
        expect(meta()).not.toHaveProperty('title')
        expect(meta()).not.toHaveProperty('description')
        expect(meta()).not.toHaveProperty('robots')
        expect(useHead).not.toHaveBeenCalled()
    })
    it('merges global, entry/input, actual-path rules and explicit page overrides in order', () => {
        const { useSeo, route, meta, useHead } = initialize(false, {
            seo: {
                title: 'Global',
                titleTemplate: '%s | Global',
                description: 'Global description',
                twitterCard: 'summary_large_image',
            },
            routeRules: {
                '/**': { seo: { description: 'Broad rule' } },
                '/ja/posts/**': { seo: { description: 'Japanese rule', robots: 'noindex, follow' } },
                '/ja/posts/note': { seo: { title: 'Exact rule', titleTemplate: null } },
            },
        })
        route.path = '/ja/posts/note?query=yes#section'
        useSeo(
            {
                title: 'Entry',
                description: 'Entry description',
                canonical: '/ja/posts/note',
                alternates: [{ locale: 'en', path: '/en/posts/note' }],
            },
            { title: 'Page', twitterCard: 'summary' },
        )
        expect(meta()).toMatchObject({
            title: 'Page',
            description: 'Japanese rule',
            robots: 'noindex, follow',
            twitterCard: 'summary',
            ogType: 'website',
        })
        const input = useHead.mock.calls[0]![0] as () => unknown
        expect(input()).toEqual({
            titleTemplate: null,
            link: [
                { rel: 'canonical', href: 'https://example.test/ja/posts/note' },
                { rel: 'alternate', hreflang: 'en', href: 'https://example.test/en/posts/note' },
            ],
        })
        route.path = '/en/posts/note'
        expect(meta()).toMatchObject({ title: 'Page', description: 'Broad rule' })
        expect(meta().robots).toBeUndefined()
    })

    it('keeps value/ref/getter inputs reactive and applies component images atomically', async () => {
        const input = ref<Input>({ title: 'Entry', image: { component: 'Entry.takumi', props: { title: 'Entry' } } })
        const override = ref<Input>({ description: 'First' })
        const { useSeo, meta, defineOgImage, route } = initialize(true, {
            seo: { image: { component: 'Global.takumi', props: { legacy: 'Do not inherit' } } },
            routeRules: { '/posts/**': { seo: { image: { component: 'Post.takumi' } } } },
        })
        route.path = '/posts/a'
        useSeo(() => input.value, override)
        expect(defineOgImage).toHaveBeenLastCalledWith('Post.takumi', undefined, undefined)
        input.value = { title: 'Updated', image: 'https://example.test/entry.png' }
        override.value = { description: 'Updated description', image: false }
        await nextTick()
        expect(meta()).toMatchObject({
            title: 'Updated',
            description: 'Updated description',
            ogImage: null,
            twitterImage: null,
        })
        expect(defineOgImage).toHaveBeenCalledOnce()
        route.path = '/else'
        override.value = {
            image: { component: 'Other.takumi', options: [{ key: 'og' }, { key: 'square', width: 800, height: 800 }] },
        }
        await nextTick()
        expect(defineOgImage).toHaveBeenLastCalledWith('Other.takumi', undefined, [
            { key: 'og' },
            { key: 'square', width: 800, height: 800 },
        ])
    })

    it('beats lazy high-priority OG tags in actual Unhead SSR resolution regardless registration order', async () => {
        const head = nativeHead.createHead()
        const { useSeo } = initialize(true, {}, head)
        useSeo({ title: 'Page', twitterCard: 'summary', image: { component: 'Default.takumi' } })
        // A separate root/app OG call can register after the page helper too.
        head.push({ meta: () => [{ name: 'twitter:card', content: 'summary_large_image' }] }, { tagPriority: 'high' })
        const { headTags } = await head.render()
        expect(headTags.match(/name="twitter:card"/gu)).toHaveLength(1)
        expect(headTags).toMatch(/name="twitter:card"[^>]+content="summary"/u)
    })

    it('clears inherited title templates and disables earlier generated image tags in actual Unhead', async () => {
        const head = nativeHead.createHead()
        head.push(
            {
                titleTemplate: '%s | Earlier',
                meta: [
                    { property: 'og:image', content: 'https://example.test/old.png' },
                    { name: 'twitter:image', content: 'https://example.test/old.png' },
                    { property: 'og:image:type', content: 'image/png' },
                    { property: 'og:image:width', content: 1200 },
                    { property: 'og:image:height', content: 600 },
                    { property: 'og:image:alt', content: 'Old' },
                    { name: 'twitter:image:alt', content: 'Old' },
                ],
            },
            { tagPriority: 'high' },
        )
        const { useSeo } = initialize(false, {}, head)
        useSeo({ title: 'Page', titleTemplate: null, image: false })
        const { headTags } = await head.render()
        expect(headTags).toContain('<title>Page</title>')
        expect(headTags).not.toContain('og:image')
        expect(headTags).not.toContain('twitter:image')
    })

    it('reacts from absent DTO to component, URL and false without losing scope/context or leaking tags', async () => {
        const head = nativeHead.createHead()
        const input = ref<Input>()
        const { useSeo, defineOgImage, contexts, scope, meta } = initialize(true, {}, head)
        useSeo(() => input.value)
        expect(defineOgImage).not.toHaveBeenCalled()
        input.value = { title: 'Loaded', image: { component: 'First.takumi' } }
        await nextTick()
        expect(defineOgImage).toHaveBeenLastCalledWith('First.takumi', undefined, undefined)
        expect(contexts).toEqual([{ nuxt: true, scope }])
        input.value = { title: 'Loaded', image: 'https://example.test/url.png' }
        await nextTick()
        const urlTags = (await head.render()).headTags
        expect(urlTags).toContain('https://example.test/url.png')
        expect(urlTags).not.toContain('generated.png')
        input.value = { title: 'Loaded', image: false }
        await nextTick()
        // Server heads render once; native client reactivity receives these null tombstones.
        expect(meta()).toMatchObject({ ogImage: null, twitterImage: null })
        scope.stop()
        input.value = { image: { component: 'AfterUnmount.takumi' } }
        await nextTick()
        expect(defineOgImage).toHaveBeenCalledOnce()
    })

    it.each([undefined, { title: 'Next entry without an image' }])(
        "clears this helper's generated image when its reactive DTO loses the component (%j)",
        async (nextInput) => {
            const head = nativeHead.createHead()
            const input = ref<Input>({ title: 'Loaded', image: { component: 'First.takumi' } })
            const { useSeo, defineOgImage, meta } = initialize(true, {}, head)
            useSeo(() => input.value)
            expect(defineOgImage).toHaveBeenCalledOnce()
            input.value = nextInput
            await nextTick()
            expect(meta()).toMatchObject({
                ogImage: null,
                twitterImage: null,
                ogImageType: null,
                ogImageWidth: null,
                ogImageHeight: null,
                ogImageAlt: null,
                ogImageSecureUrl: null,
                twitterImageAlt: null,
            })
            // Render the final reactive state once, matching the native server-head lifecycle.
            const { headTags } = await head.render()
            expect(headTags).not.toContain('og:image')
            expect(headTags).not.toContain('twitter:image')
            expect(defineOgImage).toHaveBeenCalledOnce()
        },
    )

    it('retains unrelated native app images when this helper starts with an omitted image', async () => {
        const head = nativeHead.createHead()
        head.push(
            {
                meta: () => [
                    { property: 'og:image', content: 'https://example.test/app.png' },
                    { name: 'twitter:image', content: 'https://example.test/app.png' },
                    { property: 'og:image:width', content: 1200 },
                    { property: 'og:image:alt', content: 'App-owned' },
                ],
            },
            { tagPriority: 'high' },
        )
        const input = ref<Input>()
        const { useSeo, defineOgImage, meta } = initialize(true, {}, head)
        useSeo(() => input.value)
        input.value = { title: 'Loaded without an image' }
        await nextTick()
        expect(meta()).toMatchObject({ ogImage: undefined, twitterImage: undefined, ogImageWidth: undefined })
        expect(defineOgImage).not.toHaveBeenCalled()
        const { headTags } = await head.render()
        expect(headTags).toContain('https://example.test/app.png')
        expect(headTags).toContain('property="og:image:width"')
        expect(headTags).toContain('App-owned')
    })

    it('keeps URL and false image metadata usable without optional OG component code', () => {
        const source = siteAdminNuxtSeoTemplate({ ogImage: false })
        expect(source).not.toContain('defineOgImage')
        expect(source).not.toContain('NativeOgImage')
        const { useSeo, meta, defineOgImage } = initialize(false)
        useSeo({ title: 'Page', image: '/image.png' })
        expect(meta()).toMatchObject({
            title: 'Page',
            ogImage: '/image.png',
            twitterImage: '/image.png',
            twitterCard: 'summary_large_image',
        })
        expect(defineOgImage).not.toHaveBeenCalled()
    })
})
