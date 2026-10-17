import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { Files } from 'files-sdk'
import { memory } from 'files-sdk/memory'
import { defineSiteAdminConfig, text, file, relation, markdown } from '../packages/site-admin/src'
import { createMigratedTestAdmin, testAdapter } from './migrate'
import { createMemoryDatabase } from './memory-storage'
import { createSiteAdmin } from '../packages/site-admin/src/server'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.dispose()))
})

it('retries all DB pages when publication changes during an all-entry read', async () => {
    const database = createMemoryDatabase()
    const admin = createSiteAdmin({
        database,
        config: defineSiteAdminConfig({ models: { posts: { publishing: false, fields: { title: text() } } } }),
    })
    const entries: Array<{ id: string; version: number }> = []
    for (let index = 0; index < 101; index++) entries.push(await admin.createEntry('posts', { data: { title: 'old' } }))
    let changed = false
    const page = database.storage.pagePublished.bind(database.storage)
    const reads = vi.spyOn(database.storage, 'pagePublished').mockImplementation(async (filter, bounds) => {
        const result = await page(filter, bounds)
        if (!changed) {
            changed = true
            for (const entry of entries)
                await admin.updateEntry(entry.id, { expectedVersion: entry.version, data: { title: 'new' } })
        }
        return result
    })
    const result = await admin.listPublicEntries('posts')
    expect(result).toHaveLength(101)
    expect(result.every((entry) => entry.data.title === 'new')).toBe(true)
    expect(reads).toHaveBeenCalledTimes(4)
    reads.mockRestore()
})

const setup = async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    await database.exec('PRAGMA foreign_keys=ON')
    const admin = await createMigratedTestAdmin({
        database,
        locales: {
            defaultLocale: 'ja',
            supported: ['ja', 'en', 'fr'],
            localizePath: (path, locale) => `/${locale}${path}`,
        },
        config: defineSiteAdminConfig({
            models: {
                posts: {
                    publishing: false,
                    fields: { slug: text({ i18n: true }), title: text({ required: true, i18n: true }), image: text() },
                    route: '/posts/:slug',
                },
            },
        }),
    })
    return { admin, database }
}

it('stores sparse translation children, restores the complete immediate-public snapshot and searches without writes', async () => {
    const { admin, database } = await setup()
    let entry = await admin.createEntry('posts', {
        defaultLocale: 'ja',
        data: { slug: 'original', title: '原本', image: 'shared' },
        translations: { en: { slug: 'english', title: 'Hello' } },
    })
    const original = entry.currentRevisionId
    expect(await admin.getPublicEntry('posts', entry.id, 'en')).toMatchObject({
        id: entry.id,
        defaultLocale: 'ja',
        locale: 'en',
        data: { title: 'Hello', image: 'shared' },
        path: '/en/posts/english',
    })
    expect(await admin.getPublicEntry('posts', entry.id, 'fr')).toMatchObject({ locale: 'ja', data: { title: '原本' } })
    expect(await admin.resolvePath('/en/posts/english')).toMatchObject({ kind: 'page' })
    entry = await admin.updateEntry(entry.id, {
        expectedVersion: entry.version,
        data: { title: '更新', image: 'changed' },
        translations: { en: { title: 'Updated' } },
    })
    expect(
        (await admin.pageEntries({ models: ['posts'], locale: 'en', q: 'updated' }, { limit: 20, offset: 0 })).total,
    ).toBe(1)
    const generation = await admin.publicGeneration()
    entry = await admin.restoreRevision(entry.id, original, { expectedVersion: entry.version })
    expect(entry.data.title).toBe('原本')
    expect(await admin.getPublicEntry('posts', entry.id, 'en')).toMatchObject({
        data: { title: 'Hello', image: 'shared' },
    })
    expect(await admin.publicGeneration()).toBeGreaterThan(generation)
    expect(await database.prepare('SELECT COUNT(*) AS total FROM site_admin_translations').get()).toMatchObject({
        total: 3,
    })
    await expect(
        admin.updateEntry(entry.id, { expectedVersion: entry.version, translations: { en: { image: 'invalid' } } }),
    ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
    for (const translations of [{ ja: {} }, { de: {} }])
        await expect(
            admin.updateEntry(entry.id, { expectedVersion: entry.version, translations }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
    entry = await admin.updateEntry(entry.id, { expectedVersion: entry.version, translations: { en: null } })
    expect(await admin.getPublicEntry('posts', entry.id, 'en')).toMatchObject({
        locale: 'ja',
        path: '/ja/posts/original',
    })
    expect(await admin.resolvePath('/en/posts/english')).toBeNull()
    expect(
        (await admin.pageEntries({ models: ['posts'], locale: 'en', q: 'hello' }, { limit: 20, offset: 0 })).total,
    ).toBe(0)
})

it('includes translation-only Assets and relations in copy, deletion and committed-effect recovery', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    await database.exec('PRAGMA foreign_keys=ON')
    const draft = new Files({ adapter: memory() }),
        publicFiles = new Files({ adapter: memory() })
    const admin = await createMigratedTestAdmin({
        database,
        locales: { defaultLocale: 'ja', supported: ['ja', 'en'] },
        getFiles: async (name) => (name === 'draft' ? draft : publicFiles),
        config: defineSiteAdminConfig({
            assets: { storage: 'content', separateDrafts: true, cleanup: { minimumAge: 0 } },
            models: {
                authors: { publishing: false, fields: { name: text() } },
                posts: {
                    fields: {
                        title: text({ i18n: true }),
                        attachment: file({ i18n: true }),
                        author: relation('authors', { i18n: true }),
                    },
                },
            },
        }),
    })
    const author = await admin.createEntry('authors', { data: { name: 'Author' } })
    const asset = await admin.uploadAsset({ body: 'translation only', filename: 'english.txt' })
    let post = await admin.createEntry('posts', {
        data: { title: '原本' },
        translations: { en: { title: 'English', attachment: asset.id, author: author.id } },
    })
    const upload = vi.spyOn(publicFiles, 'upload').mockRejectedValueOnce(new Error('Synthetic copy failure'))
    await expect(admin.publishEntry(post.id, { expectedVersion: post.version })).rejects.toMatchObject({
        committed: true,
        receipt: { id: post.id, model: 'posts', version: post.version + 1 },
        effects: { assets: 'pending' },
    })
    upload.mockRestore()
    post = await admin.getEntry(post.id)
    const revisions = await admin.listRevisions(post.id)
    expect(await admin.syncAssetCopies()).toMatchObject({ copied: [asset.id], failed: [] })
    expect(await admin.listRevisions(post.id)).toEqual(revisions)
    expect((await admin.getEntry(post.id)).version).toBe(post.version)
    expect(await admin.downloadAsset(asset.id)).toHaveProperty('file')
    await expect(admin.deleteAsset(asset.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_ASSET_IN_USE' })
    await expect(admin.deleteEntry(author.id, { expectedVersion: author.version })).rejects.toMatchObject({
        code: 'SITE_ADMIN_RELATION_BLOCKED',
    })
    const deletion = vi.spyOn(publicFiles, 'delete').mockRejectedValueOnce(new Error('Synthetic delete failure'))
    await expect(admin.deleteEntry(post.id, { expectedVersion: post.version })).rejects.toMatchObject({
        committed: true,
        receipt: { id: post.id, model: 'posts', version: post.version + 1, deleted: true },
    })
    deletion.mockRestore()
    await expect(admin.getEntry(post.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_ENTRY_NOT_FOUND' })
    expect(await admin.syncAssetCopies()).toMatchObject({ failed: [] })
    expect(
        await database
            .prepare('SELECT COUNT(*) AS total FROM site_admin_revisions WHERE entry_id=?')
            .bind(post.id)
            .get(),
    ).toMatchObject({ total: 0 })
})

it('parses only a selected document or page with mixed original languages', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    const parse = vi.fn()
    const admin = await createMigratedTestAdmin({
        database,
        locales: {
            defaultLocale: 'ja',
            supported: ['ja', 'en', 'fr'],
            localizePath: (path, locale) => '/' + locale + path,
        },
        config: defineSiteAdminConfig({
            markdown: { plugins: [{ name: 'parse-count', post: parse }] },
            models: {
                posts: {
                    publishing: false,
                    route: '/posts/:slug',
                    fields: { slug: text({ i18n: true }), body: markdown({ i18n: true }) },
                },
            },
        }),
    })
    const originals = []
    for (let index = 0; index < 3; index++)
        originals.push(
            await admin.createEntry('posts', {
                defaultLocale: index === 0 ? 'en' : 'ja',
                data: { slug: 'original-' + index, body: 'Original ' + index },
                translations: {
                    [index === 0 ? 'ja' : 'en']: { slug: 'translation-' + index, body: 'Translated ' + index },
                    ...(index === 2 ? { fr: { slug: 'french', body: 'UNREQUESTED_FRENCH_BODY' } } : {}),
                },
            }),
        )
    expect(await admin.getPublicEntry('posts', originals[0]!.id)).toMatchObject({
        locale: 'en',
        path: '/en/posts/original-0',
    })
    const storage = (await testAdapter(database, admin.config)).bind(admin.config)
    const selected = await storage.published({ model: 'posts', ids: [originals[2]!.id], locale: 'en' })
    expect(Object.keys(selected[0]!.translations)).toEqual(['en'])
    expect(JSON.stringify(selected)).not.toContain('UNREQUESTED_FRENCH_BODY')
    const routes = await storage.publicTranslations([originals[2]!.id])
    expect(routes.find((value) => value.locale === 'fr')?.data).toEqual({ slug: 'french' })
    expect(JSON.stringify(routes)).not.toContain('UNREQUESTED_FRENCH_BODY')
    expect(await admin.contentDocument('posts', originals[0]!.id, 'fr')).toHaveProperty('data')
    expect(parse).toHaveBeenCalledTimes(1)
    const page = await admin.contentPage('posts', { limit: 1, offset: 1 }, 'ja')
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(1)
    expect(parse).toHaveBeenCalledTimes(2)
    const fallback = await admin.getPublicEntry('posts', originals[0]!.id, 'fr')
    expect(fallback).toMatchObject({
        defaultLocale: 'en',
        locale: 'en',
        path: '/en/posts/original-0',
        localeParams: { en: { slug: 'original-0' }, ja: { slug: 'translation-0' }, fr: false },
    })
    expect(fallback?.alternates).toHaveLength(2)
})
