import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import {
    createSiteAdminRouteResolver,
    mergeSiteAdminSeo,
    normalizeSiteAdminPath,
    serializeSiteAdminRouteRules,
    serializeSiteAdminSeo,
} from '../packages/site-admin/src/seo'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const database = () => {
    const value = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(value)
    return value
}

describe('shared route rules', () => {
    it('matches overlapping rou3 patterns broad to specific, actual localized paths only', () => {
        const resolve = createSiteAdminRouteResolver({
            '/posts/specific': { seo: { title: 'Specific', titleTemplate: null }, sitemap: true },
            '/posts/**': { seo: { titleTemplate: '%s | Posts', type: 'article' }, llms: false, sitemap: false },
            '/ja/posts/**': { seo: { titleTemplate: '%s | Japanese' }, sitemap: false },
            '/**': { seo: { titleTemplate: '%s | Site', description: 'Global route description' }, sitemap: true },
        })
        expect(resolve('https://example.com/posts/specific?preview=yes#section')).toEqual({
            llms: false,
            seo: { title: 'Specific', titleTemplate: null, type: 'article', description: 'Global route description' },
            sitemap: true,
        })
        expect(resolve('/posts/ordinary/')).toMatchObject({
            seo: { titleTemplate: '%s | Posts', type: 'article' },
            llms: false,
            sitemap: false,
        })
        expect(resolve('/ja/posts/ordinary')).toEqual({
            seo: { description: 'Global route description', titleTemplate: '%s | Japanese' },
            sitemap: false,
        })
        expect(resolve('/translated/ja/posts/ordinary')).toEqual({
            seo: { description: 'Global route description', titleTemplate: '%s | Site' },
            sitemap: true,
        })
        expect(normalizeSiteAdminPath('/posts/../pages/home?key=value#fragment')).toBe('/pages/home')
        expect(createSiteAdminRouteResolver()('/posts/test')).toEqual({})
    })

    it('merges only defined values and replaces images atomically including null template and false image', () => {
        expect(
            mergeSiteAdminSeo(
                { title: 'Global', titleTemplate: '%s | Site', image: { component: 'GlobalOg', props: { old: true } } },
                { title: 'Entry', image: '/published-cover.png' },
                {
                    titleTemplate: null,
                    image: { component: 'RouteOg', options: [{ key: 'og' }, { key: 'whatsapp', width: 800 }] },
                },
                { description: 'Page description', image: false },
            ),
        ).toEqual({ title: 'Entry', titleTemplate: null, description: 'Page description', image: false })
        expect(
            mergeSiteAdminSeo<{ title?: string | undefined; image?: object }>(
                { title: 'Configured', image: { component: 'FirstOg', props: { old: true } } },
                { title: undefined, image: { component: 'NextOg', props: { new: true } } },
            ),
        ).toEqual({ title: 'Configured', image: { component: 'NextOg', props: { new: true } } })
        expect(mergeSiteAdminSeo({ image: false }, { image: '/entry.png' })).toEqual({ image: '/entry.png' })
    })

    it('only exposes supported JSON configuration and preserves OG configuration arrays', () => {
        const input = {
            titleTemplate: null,
            robots: 'noindex, follow',
            unknownCredential: 'secret',
            image: {
                component: 'PostOg',
                props: { public: 'title', callback: () => 'secret' },
                options: [{ key: 'og' }, { key: 'whatsapp', width: 800, callback: () => 'secret' }],
            },
        }
        const safe = {
            titleTemplate: null,
            robots: 'noindex, follow',
            image: {
                component: 'PostOg',
                props: { public: 'title' },
                options: [{ key: 'og' }, { key: 'whatsapp', width: 800 }],
            },
        }
        expect(serializeSiteAdminSeo(input)).toEqual(safe)
        expect(
            serializeSiteAdminRouteRules({ '/posts/**': { seo: input, llms: false, unknownCredential: 'secret' } }),
        ).toEqual({
            '/posts/**': { seo: safe, llms: false },
        })
        expect(JSON.stringify(serializeSiteAdminRouteRules({ '/posts/**': { seo: input } }))).not.toContain('secret')
    })

    it('filters existing published public sitemap/llms paths with model then matched rule precedence', async () => {
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: {
                    posts: { fields: { title: text() }, route: '/posts/:slug' },
                    excluded: {
                        fields: { title: text() },
                        route: { path: '/excluded/:slug', sitemap: false, llms: false },
                    },
                    localized: { fields: { title: text() }, route: '/localized/:slug', localized: true },
                    routeLess: { fields: { title: text() }, publishing: false },
                    private: { fields: { title: text() }, public: false, publishing: false, route: true },
                },
                routeRules: {
                    '/**': { seo: { titleTemplate: '%s | Site' }, sitemap: true, llms: true },
                    '/posts/**': { sitemap: false, llms: false },
                    '/posts/included': { sitemap: true, llms: true },
                    '/ja/localized/**': { sitemap: false, llms: false },
                },
            }),
            database: database(),
            locales: {
                defaultLocale: 'en',
                supported: ['en', 'ja'],
                localizePath: (path, locale) => (locale === 'en' ? path : `/${locale}${path}`),
            },
        })
        for (const [model, slug, locale] of [
            ['posts', 'included'],
            ['posts', 'hidden'],
            ['excluded', 'rule-included'],
            ['localized', 'english', 'en'],
            ['localized', 'japanese', 'ja'],
        ]) {
            const entry = await admin.createEntry(model!, {
                slug: slug!,
                data: { title: slug },
                ...(locale ? { locale } : {}),
            })
            await admin.publishEntry(entry.id, { expectedVersion: entry.version })
        }
        await admin.createEntry('posts', { slug: 'draft', data: { title: 'Draft' } })
        await admin.createEntry('routeLess', { data: { title: 'No page' } })
        await admin.createEntry('private', { data: { title: 'Private page' } })
        expect((await admin.sitemap()).map((entry) => entry.loc).sort()).toEqual([
            '/excluded/rule-included',
            '/localized/english',
            '/posts/included',
        ])
        expect((await admin.llmsEntries()).map((entry) => entry.href).sort()).toEqual([
            '/excluded/rule-included',
            '/localized/english',
            '/posts/included',
        ])
        const entry = await admin.getPublicEntry('posts', 'included')
        // Route SEO remains page-owned. No global or route configuration is baked into entry metadata.
        expect(entry?.seo).toEqual({ title: 'included', canonical: '/posts/included' })
    })
})
