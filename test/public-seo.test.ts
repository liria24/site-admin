import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { Files } from 'files-sdk'
import { memory } from 'files-sdk/memory'
import { defineSiteAdminConfig, image, images, markdown, text, textarea } from '../packages/site-admin/src'
import type { PublicEntry, PublicEntrySeo } from '../packages/site-admin/src/server'
import { createSiteAdmin, handlePublicRequest } from '../packages/site-admin/src/server'
import { createSiteAdminClient } from '../packages/site-admin/src/client'
import { createSiteAdminDescriptor } from '../packages/site-admin/src/descriptor'
import { createMigratedTestAdmin, migrateTestDatabase, testAdapter } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const database = () => {
    const value = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(value)
    return value
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('public entry SEO payload', () => {
    it.each([
        { name: 'later text', body: '---', description: ' Later text ', summary: '---', expected: 'Later text' },
        {
            name: 'later Markdown',
            body: '---',
            description: ' ',
            summary: 'Later **summary**',
            expected: 'Later summary',
        },
        { name: 'disabled summary', body: 'FULL_BODY', description: ' ', summary: '---', expected: undefined },
    ])('selects usable description candidates for full and summary: $name', async (candidate) => {
        const parsed = vi.fn()
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                markdown: {
                    summary: { enabled: candidate.name !== 'disabled summary' },
                    plugins: [{ name: 'description-parse-count', post: parsed }],
                },
                models: {
                    posts: {
                        fields: { body: markdown(), description: textarea(), summary: markdown() },
                        displayFields: { description: 'body' },
                    },
                },
            }),
            database: database(),
        })
        const entry = await admin.createEntry('posts', {
            data: { body: candidate.body, description: candidate.description, summary: candidate.summary },
        })
        await admin.publishEntry(entry.id, { expectedVersion: entry.version })
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            origin: 'https://example.test',
            fetch: (input, init) => handlePublicRequest(admin, new Request(input, init)),
        })
        expect((await client.list('posts'))[0]?.seo?.description).toBe(candidate.expected ?? 'FULL_BODY')
        const count = parsed.mock.calls.length
        expect((await client.list('posts', { markdown: 'summary' }))[0]?.seo?.description).toBe(candidate.expected)
        expect(parsed).toHaveBeenCalledTimes(count)
        expect((await client.get('posts', entry.id))?.seo?.description).toBe(candidate.expected ?? 'FULL_BODY')
    })
    it('retains the complete model list after sequential detail parsing and publication', async () => {
        const plugin = vi.fn()
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                markdown: { plugins: [{ name: 'detail-list-count', post: plugin }] },
                models: {
                    posts: {
                        fields: { title: text(), body: markdown() },
                        displayFields: { description: 'body' },
                        route: '/posts/:slug',
                    },
                },
            }),
            database: database(),
        })
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            origin: 'https://example.test',
            fetch: (input, init) => handlePublicRequest(admin, new Request(input, init)),
        })
        for (const slug of ['one', 'two']) {
            const entry = await admin.createEntry('posts', {
                slug,
                data: { title: slug, body: `${slug} intro\n\n<!-- more -->\n\n${slug} full body` },
            })
            await admin.publishEntry(entry.id, { expectedVersion: entry.version })
            expect(await admin.resolvePath(`/posts/${slug}`)).toMatchObject({ entry: { slug } })
            expect(await client.get('posts', slug)).toMatchObject({ slug })
        }
        expect((await client.list('posts')).map(({ slug }) => slug).sort()).toEqual(['one', 'two'])
        const parsed = plugin.mock.calls.length
        expect((await (await admin.content('posts')).list()).map(({ data }) => String(data.title)).sort()).toEqual([
            'one',
            'two',
        ])
        expect(await client.get('posts', 'one')).toMatchObject({ seo: { description: 'one intro' } })
        expect(plugin).toHaveBeenCalledTimes(parsed)
    })
    it.each(['route-first', 'content-first'])(
        'shares Markdown summary SEO between route and content (%s)',
        async (order) => {
            const plugin = vi.fn()
            const admin = await createMigratedTestAdmin({
                config: defineSiteAdminConfig({
                    markdown: { plugins: [{ name: 'route-seo-count', post: plugin }] },
                    models: {
                        posts: {
                            displayFields: { description: 'body' },
                            fields: { title: text(), body: markdown() },
                            route: '/posts/:slug',
                        },
                    },
                }),
                database: database(),
            })
            const draft = await admin.createEntry('posts', {
                slug: 'hello',
                data: { title: 'Post', body: 'Intro **summary**.\n\n<!-- more -->\n\nFull body' },
            })
            await admin.publishEntry(draft.id, { expectedVersion: draft.version })
            if (order === 'content-first') await (await admin.content('posts')).list()
            const response = await handlePublicRequest(
                admin,
                new Request('https://example.test/api/content/_route?path=/posts/hello'),
            )
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                kind: 'page',
                entry: { seo: { title: 'Post', canonical: '/posts/hello', description: 'Intro summary .' } },
            })
            expect((await (await admin.content('posts')).list())[0]?.data).toMatchObject({
                _siteAdmin: { seo: { description: 'Intro summary .' } },
            })
            expect(plugin).toHaveBeenCalledTimes(1)
        },
    )
    it('resolves model defaults and projected fields without descriptors or fetch-side head work', async () => {
        const resolver = vi.fn((entry: PublicEntry) => {
            expect(entry.data.cover).toMatchObject({ alt: 'Public cover', url: expect.stringContaining('/_assets/') })
            expect(entry.data.body).toBe('Published **Markdown**')
            entry.data.title = 'Resolver mutation must not change the entry'
            return {
                description: 'Model description',
                title: 'Model title',
                titleTemplate: '%s | Posts',
                type: 'article' as const,
                twitterCard: 'summary' as const,
            }
        })
        const config = defineSiteAdminConfig({
            assets: { storage: 'content' },
            seo: { titleTemplate: '%s | Global', description: 'Global default' },
            models: {
                posts: {
                    displayFields: { description: 'excerpt', image: 'cover', title: 'heading' },
                    fields: { body: markdown(), cover: image(), excerpt: textarea(), heading: text(), title: text() },
                    route: '/writing/:slug',
                    seo: resolver,
                },
            },
        })
        const admin = await createMigratedTestAdmin({
            config,
            database: database(),
            getFiles: async () => new Files({ adapter: memory() }),
            site: { url: 'https://example.com' },
        })
        const asset = await admin.uploadAsset({ body: png, filename: 'cover.png' })
        const draft = await admin.createEntry('posts', {
            slug: 'published',
            data: {
                body: 'Published **Markdown**',
                cover: { alt: 'Public cover', id: asset.id },
                excerpt: '  Published\n description  ',
                heading: '  Published heading  ',
                title: 'Ordinary title',
            },
        })
        const published = await admin.publishEntry(draft.id, { expectedVersion: draft.version })
        await admin.updateEntry(draft.id, {
            data: { ...published.data, heading: 'Private draft heading' },
            expectedVersion: published.version,
        })
        const requests: string[] = []
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            origin: 'https://example.com',
            fetch: (input, init) => {
                requests.push(String(input))
                return handlePublicRequest(admin, new Request(input, init))
            },
        })
        const fetched = await client.get('posts', draft.id)
        expect(fetched?.seo).toEqual({
            canonical: 'https://example.com/writing/published',
            description: 'Published description',
            image: `https://example.com/api/content/_assets/${asset.id}`,
            title: 'Published heading',
            titleTemplate: '%s | Posts',
            twitterCard: 'summary',
            type: 'article',
        })
        expect(fetched?.data.title).toBe('Ordinary title')
        expect(fetched?.data.heading).toBe('  Published heading  ')
        expect(requests).toEqual([`https://example.com/api/content/posts/${draft.id}`])
        expect(resolver).toHaveBeenCalledTimes(1)
        const listed = await client.list('posts')
        expect(listed[0]?.seo).toEqual(fetched?.seo)
        expect(resolver).toHaveBeenCalledTimes(1)
        const serialized = JSON.stringify(createSiteAdminDescriptor(config))
        expect(serialized).not.toContain('Model description')
        expect(serialized).not.toContain('Global default')
        expect(serialized).not.toContain('Resolver mutation')
    })

    it('preserves configured values when derived values are absent, including explicit image false/component', async () => {
        const component = { component: 'PostOg', props: { title: 'Public OG', nested: { ok: true } } }
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                assets: { storage: 'content' },
                seo: { title: 'Global', titleTemplate: '%s | Global' },
                models: {
                    settings: {
                        fields: { title: text(), description: textarea() },
                        publishing: false,
                        seo: { title: 'Configured', description: 'Configured description', canonical: '/settings' },
                    },
                    disabled: { fields: { cover: image() }, publishing: false, seo: { image: false } },
                    generated: { fields: { cover: image() }, publishing: false, seo: { image: component } },
                    gallery: { fields: { pictures: images() }, publishing: false, seo: { image: '/default.png' } },
                },
            }),
            database: database(),
            getFiles: async () => new Files({ adapter: memory() }),
            site: { url: 'https://example.com' },
        })
        const asset = await admin.uploadAsset({ body: png, filename: 'cover.png' })
        const settings = await admin.createEntry('settings', { data: { title: '', description: null } })
        const disabled = await admin.createEntry('disabled', { data: { cover: asset.id } })
        const generated = await admin.createEntry('generated', { data: { cover: asset.id } })
        const gallery = await admin.createEntry('gallery', { data: { pictures: [asset.id] } })
        expect((await admin.getPublicEntry('settings', settings.id))?.seo).toEqual({
            canonical: 'https://example.com/settings',
            description: 'Configured description',
            title: 'Configured',
        })
        const response = await handlePublicRequest(
            admin,
            new Request('https://example.com/api/content/settings?markdown=summary'),
        )
        expect(await response.json()).toMatchObject([
            { data: { _siteAdmin: { seo: { description: 'Configured description' } } } },
        ])
        expect((await admin.getPublicEntry('disabled', disabled.id))?.seo).toEqual({ image: false })
        expect((await admin.getPublicEntry('generated', generated.id))?.seo).toEqual({ image: component })
        expect((await admin.getPublicEntry('gallery', gallery.id))?.seo).toEqual({
            image: `https://example.com/api/content/_assets/${asset.id}`,
        })
    })

    it.each([false, { component: 'GlobalOg', props: { title: 'Global image' } }] as const)(
        'keeps the model-derived image independent from the global default: %j',
        async (globalImage) => {
            const admin = await createMigratedTestAdmin({
                config: defineSiteAdminConfig({
                    assets: { storage: 'content' },
                    seo: { image: globalImage },
                    models: {
                        posts: { fields: { cover: image() }, publishing: false },
                        overridden: { fields: { cover: image() }, publishing: false, seo: { image: '/model.png' } },
                    },
                }),
                database: database(),
                getFiles: async () => new Files({ adapter: memory() }),
                site: { url: 'https://example.com' },
            })
            const asset = await admin.uploadAsset({ body: png, filename: 'cover.png' })
            const entry = await admin.createEntry('posts', { data: { cover: asset.id } })
            const overridden = await admin.createEntry('overridden', { data: { cover: asset.id } })
            // Globals remain page-owned and are not baked into the entry DTO.
            expect((await admin.getPublicEntry('posts', entry.id))?.seo).toEqual({
                image: `https://example.com/api/content/_assets/${asset.id}`,
            })
            expect((await admin.getPublicEntry('overridden', overridden.id))?.seo).toEqual({
                image: `https://example.com/api/content/_assets/${asset.id}`,
            })
        },
    )

    it('uses published localized routes for canonical and alternates while excluding draft/private/unsafe siblings', async () => {
        const privateResolver = vi.fn(() => ({ title: 'Private model SEO' }))
        const db = database()
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                assets: { storage: 'content' },
                models: {
                    pages: { fields: { title: text(), cover: image() }, localized: true, route: '/pages/:slug' },
                    secrets: {
                        fields: { title: text() },
                        localized: true,
                        public: false,
                        publishing: false,
                        route: true,
                        seo: privateResolver,
                    },
                },
            }),
            database: db,
            getFiles: async () => new Files({ adapter: memory() }),
            locales: {
                defaultLocale: 'en',
                localizePath: (path, locale) => (locale === 'en' ? path : `/translated/${locale}${path}`),
                supported: ['en', 'ja', 'fr', 'de'],
            },
            site: { url: 'https://example.com' },
        })
        const en = await admin.createEntry('pages', {
            data: { title: 'English' },
            locale: 'en',
            slug: 'home',
            translationGroup: 'home',
        })
        const ja = await admin.createEntry('pages', {
            data: { title: '日本語' },
            locale: 'ja',
            slug: 'ホーム',
            translationGroup: 'home',
        })
        await admin.createEntry('pages', {
            data: { title: 'French draft' },
            locale: 'fr',
            slug: 'draft',
            translationGroup: 'home',
        })
        await admin.createEntry('secrets', {
            data: { title: 'Private German' },
            locale: 'de',
            translationGroup: 'home',
        })
        const unavailableAsset = await admin.uploadAsset({ body: png, filename: 'unavailable.png' })
        const de = await admin.createEntry('pages', {
            data: { title: 'German', cover: unavailableAsset.id },
            locale: 'de',
            slug: 'unavailable',
            translationGroup: 'home',
        })
        for (const draft of [en, ja, de]) await admin.publishEntry(draft.id, { expectedVersion: draft.version })
        await db.prepare("UPDATE site_admin_assets SET state = 'deleting' WHERE id = ?").bind(unavailableAsset.id).run()
        const projected = await admin.getPublicEntry('pages', ja.id, 'ja')
        expect(projected?.path).toBe('/translated/ja/pages/%E3%83%9B%E3%83%BC%E3%83%A0')
        expect(projected?.seo).toEqual({
            alternates: expect.arrayContaining([
                { locale: 'en', path: 'https://example.com/pages/home' },
                { locale: 'ja', path: 'https://example.com/translated/ja/pages/%E3%83%9B%E3%83%BC%E3%83%A0' },
            ]),
            canonical: 'https://example.com/translated/ja/pages/%E3%83%9B%E3%83%BC%E3%83%A0',
            title: '日本語',
        })
        expect(projected?.seo?.alternates).toHaveLength(2)
        expect(privateResolver).not.toHaveBeenCalled()
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            origin: 'https://example.com',
            fetch: (input, init) => handlePublicRequest(admin, new Request(input, init)),
        })
        expect((await client.get('pages', ja.id, { locale: 'ja' }))?.seo).toEqual(projected?.seo)
        expect((await client.list('pages', { locale: 'ja' }))[0]?.seo).toEqual(projected?.seo)
        const route = await admin.resolvePath(projected!.path!, 'ja')
        expect(route).toMatchObject({ entry: { seo: projected?.seo }, kind: 'page' })
        expect(JSON.stringify(projected)).not.toMatch(/French draft|Private German|unavailable/u)
    })

    it('bounds localized sibling queries to D1 limits across more than 100 translation groups', async () => {
        const config = defineSiteAdminConfig({
            models: {
                pages: { fields: { title: text() }, localized: true, route: '/pages/:slug' },
                secrets: { fields: { title: text() }, localized: true, public: false, publishing: false },
            },
        })
        const db = database()
        await migrateTestDatabase(db, config)
        const adapter = await testAdapter(db, config)
        const admin = createSiteAdmin({
            config,
            database: adapter,
            locales: {
                defaultLocale: 'en',
                supported: ['en', 'ja', 'fr'],
                localizePath: (path, locale) => (locale === 'en' ? path : `/${locale}${path}`),
            },
            site: { url: 'https://example.com' },
        })
        for (let index = 0; index < 101; index++) {
            for (const locale of ['en', 'ja']) {
                const entry = await admin.createEntry('pages', {
                    data: { title: `${locale} ${index}` },
                    locale,
                    slug: `${locale}-${index}`,
                    translationGroup: `group-${index}`,
                })
                await admin.publishEntry(entry.id, { expectedVersion: entry.version })
            }
        }
        await admin.createEntry('pages', {
            data: { title: 'French draft' },
            locale: 'fr',
            slug: 'draft',
            translationGroup: 'group-100',
        })
        await admin.createEntry('secrets', {
            data: { title: 'Private French' },
            locale: 'fr',
            translationGroup: 'group-100',
        })
        const native = (await db.getInstance()) as DatabaseSync
        const prepare = native.prepare.bind(native)
        let checked = 0
        vi.spyOn(native, 'prepare').mockImplementation((sql) => {
            const statement = prepare(sql)
            const all = statement.all.bind(statement)
            vi.spyOn(statement, 'all').mockImplementation((...params: Parameters<typeof all>) => {
                checked++
                expect(params.length).toBeLessThanOrEqual(100)
                return all(...params)
            })
            return statement
        })
        const entries = await admin.listPublicEntries('pages', 'en')
        expect(checked).toBeGreaterThan(0)
        expect(entries).toHaveLength(101)
        for (const entry of entries) {
            const index = entry.slug.slice(3)
            expect(entry.seo?.alternates).toEqual(
                expect.arrayContaining([
                    { locale: 'en', path: `https://example.com/pages/en-${index}` },
                    { locale: 'ja', path: `https://example.com/ja/pages/ja-${index}` },
                ]),
            )
            expect(entry.seo?.alternates).toHaveLength(2)
        }
        expect(JSON.stringify(entries)).not.toMatch(/French draft|Private French|\/draft/u)
    })

    it('derives Markdown descriptions after the existing parser without re-running plugins or resolvers', async () => {
        const plugin = vi.fn()
        const resolver = vi.fn((entry: PublicEntry) => {
            expect(entry.data.summary).toBe('Intro **summary**\n\n<!-- more -->\n\nLong body')
            return { description: 'Model fallback' }
        })
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                markdown: { plugins: [{ name: 'seo-parser-count', post: plugin }] },
                models: {
                    posts: {
                        fields: { summary: markdown() },
                        publishing: false,
                        seo: resolver,
                    },
                },
            }),
            database: database(),
        })
        const entry = await admin.createEntry('posts', {
            data: { summary: 'Intro **summary**\n\n<!-- more -->\n\nLong body' },
        })
        const client = createSiteAdminClient<Record<string, PublicEntry>>({
            origin: 'https://example.com',
            fetch: (input, init) => handlePublicRequest(admin, new Request(input, init)),
        })
        const fetched = await client.get('posts', entry.id)
        expect(fetched?.seo?.description).toBe('Intro summary')
        expect(resolver).toHaveBeenCalledTimes(1)
        expect(plugin).toHaveBeenCalledTimes(1)
        expect((await client.list('posts'))[0]?.seo?.description).toBe('Intro summary')
        expect(resolver).toHaveBeenCalledTimes(1)
        expect(plugin).toHaveBeenCalledTimes(1)
        // The direct server projection preserves its Markdown source contract.
        expect((await admin.getPublicEntry('posts', entry.id))?.seo?.description).toBe('Model fallback')
    })

    it('only serializes known SEO properties and JSON-only component inputs', async () => {
        const secret = 'server-only credential value'
        const resolver = () =>
            ({
                title: 'Public title',
                unknownCredential: secret,
                canonical: 'javascript:alert(1)',
                image: {
                    component: 'PostOg',
                    props: { public: 'Public prop', callback: () => secret, nested: { callback: () => secret } },
                    options: { width: 1200, callback: () => secret },
                },
                callback: () => secret,
            }) as unknown as PublicEntrySeo
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: { pages: { fields: { body: markdown() }, publishing: false, seo: resolver } },
            }),
            database: database(),
        })
        const entry = await admin.createEntry('pages', { data: { body: 'Public body' } })
        const projected = await admin.getPublicEntry('pages', entry.id)
        expect(projected?.seo).toEqual({
            title: 'Public title',
            image: { component: 'PostOg', props: { public: 'Public prop', nested: {} }, options: { width: 1200 } },
        })
        expect(JSON.stringify(projected)).not.toContain(secret)
        expect(JSON.stringify(projected)).not.toContain('callback')
        const response = await handlePublicRequest(
            admin,
            new Request(`https://example.com/api/content/pages/${entry.id}`),
        )
        expect(response.status).toBe(200)
        expect(await response.text()).not.toContain(secret)
    })
})
