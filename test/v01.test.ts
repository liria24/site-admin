import { createMigratedTestAdmin, testAdapter } from './migrate'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { Files } from 'files-sdk'
import { memory } from 'files-sdk/memory'

import { defineSiteAdminAuthorization, defineSiteAdminConfig, file, relation, text } from '../packages/site-admin/src'
import { handleManagementRequest, handlePublicRequest } from '../packages/site-admin/src/server'
import { queryRow, runAtomic } from '../packages/site-admin/src/server/database'

const databases: Database[] = []

afterEach(async () => Promise.all(databases.splice(0).map((database) => database.dispose())))

const database = (): Database => {
    const value = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(value)
    return value
}

const standard = <Input, Output>(validate: (value: Input) => Output) => ({
    '~standard': {
        validate: (value: unknown) => ({ value: validate(value as Input) }),
        vendor: 'test',
        version: 1 as const,
    },
})

const measure = async (size: number): Promise<{ cold: number; warm: number }> => {
    const raw = database()
    let queries = 0
    const native = (await raw.getInstance()) as import('node:sqlite').DatabaseSync
    const prepare = native.prepare.bind(native)
    native.prepare = (sql: string) => {
        queries += 1
        return prepare(sql)
    }
    const db = raw
    const admin = await createMigratedTestAdmin({
        config: defineSiteAdminConfig({
            models: { posts: { fields: { title: text() }, publishing: false } },
        }),
        database: db,
    })
    await admin.initialize()
    await runAtomic(await testAdapter(db, { models: {} }), [
        {
            params: [size],
            sql: `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
                  INSERT INTO site_admin_entries(
                      id, model, locale, translation_group, current_revision_id, published_revision_id,
                      version, created_at, updated_at, published_at
                  ) SELECT 'entry-' || n, 'posts', '', 'entry-' || n, 'revision-' || n, 'revision-' || n,
                           1, '2026-01-01', '2026-01-01', '2026-01-01' FROM seq`,
        },
        {
            params: [size],
            sql: `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
                  INSERT INTO site_admin_revisions(id, entry_id, slug, created_at)
                  SELECT 'revision-' || n, 'entry-' || n, 'post-' || n, '2026-01-01'
                  FROM seq`,
        },
        {
            sql: "INSERT INTO site_admin_content_posts(revision_id, field_title) SELECT id, 'Post' FROM site_admin_revisions",
        },
    ])
    queries = 0
    const content = await admin.content('posts')
    expect(await content.list()).toHaveLength(size)
    const cold = queries
    queries = 0
    expect(await (await admin.content('posts')).list()).toHaveLength(size)
    return { cold, warm: queries }
}

describe('v0.1 publication contract', () => {
    it('keeps cold list query counts constant and warm reads generation-only at 100/1000 entries', async () => {
        expect(await measure(100)).toEqual(await measure(1_000))
        expect((await measure(100)).warm).toBe(1)
    })

    it('reconciles route and Model policy changes and invalidates required public relations', async () => {
        const db = database()
        const initial = defineSiteAdminConfig({
            models: {
                authors: { fields: { name: text({ required: true }) } },
                posts: {
                    fields: { author: relation('authors', { required: true }), title: text() },
                    route: true,
                },
            },
        })
        const first = await createMigratedTestAdmin({ config: initial, database: db })
        const author = await first.createEntry('authors', { data: { name: 'Ada' } })
        await first.publishEntry(author.id, { expectedVersion: author.version })
        const post = await first.createEntry('posts', { data: { author: author.id, title: 'Policy' } })
        await first.publishEntry(post.id, { expectedVersion: post.version })
        const generation = await first.publicGeneration()

        const moved = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: {
                    authors: initial.models.authors,
                    posts: { ...initial.models.posts, route: '/articles/:slug' },
                },
            }),
            database: db,
        })
        await moved.initialize()
        expect(await moved.resolvePath('/articles/policy')).toMatchObject({ kind: 'page' })
        expect(await moved.resolvePath('/posts/policy')).toMatchObject({ kind: 'redirect', target: '/articles/policy' })

        const changed = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: {
                    authors: { fields: { name: text({ required: true }) }, public: false },
                    posts: initial.models.posts,
                },
            }),
            database: db,
        })
        await changed.initialize()
        expect(await changed.listPublicEntries('posts')).toEqual([])
        expect(await changed.resolvePath('/posts/policy')).toBeNull()
        expect(await changed.publicGeneration()).toBeGreaterThan(generation)

        const removed = await createMigratedTestAdmin({ config: defineSiteAdminConfig({ models: {} }), database: db })
        await removed.initialize()
        expect(await removed.routeSnapshot()).toEqual([])
    })

    it('keeps draft saves separate from published time/order and publishes sort immediately', async () => {
        const db = database()
        let now = Date.parse('2026-01-01T00:00:00.000Z')
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: { posts: { fields: { title: text() }, route: true, sortable: true } },
            }),
            database: db,
            now: () => new Date(now),
        })
        const draft = await admin.createEntry('posts', { data: { title: 'One' }, sortOrder: 1 })
        const published = await admin.publishEntry(draft.id, { expectedVersion: draft.version })
        const generation = await admin.publicGeneration()
        now += 1_000
        const edited = await admin.updateEntry(draft.id, {
            data: { title: 'Draft only' },
            expectedVersion: published.version,
        })
        expect(edited.publishedAt).toBe(published.publishedAt)
        expect(edited.sortOrder).toBe(1)
        expect(await admin.publicGeneration()).toBe(generation)
        now += 1_000
        const sorted = await admin.setSortOrder(draft.id, 2, edited.version)
        expect(sorted.publishedAt).toBe('2026-01-01T00:00:02.000Z')
        expect(await admin.publicGeneration()).toBe(generation + 1)
        expect(await admin.getPublicEntry('posts', draft.id)).toMatchObject({ data: { title: 'One' } })
    })

    it('persists Standard Schema transforms and rejects stale or implicitly changed revisions', async () => {
        const db = database()
        const v1 = defineSiteAdminConfig({
            models: {
                posts: {
                    fields: {
                        title: text({
                            required: true,
                            validate: standard<string, string>((value) => value.trim()),
                        }),
                    },
                    validate: standard<Record<string, unknown>, { title: string }>((value) => ({
                        title: String(value.title).toUpperCase(),
                    })),
                },
            },
        })
        const first = await createMigratedTestAdmin({ config: v1, database: db })
        const entry = await first.createEntry('posts', { data: { title: '  transformed  ' } })
        expect(entry.data).toEqual({ title: 'TRANSFORMED' })

        const changedTransform = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: {
                    posts: {
                        ...v1.models.posts,
                        validate: standard<Record<string, unknown>, { title: string }>((value) => ({
                            title: `${String(value.title)}!`,
                        })),
                    },
                },
            }),
            database: db,
        })
        await expect(changedTransform.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject(
            {
                code: 'SITE_ADMIN_SCHEMA_MIGRATION_REQUIRED',
            },
        )
    })

    it('restores by copying history, prunes safely, and reports current/published reverse relations', async () => {
        const db = database()
        let id = 0
        let time = Date.parse('2026-01-01T00:00:00.000Z')
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: {
                    authors: { fields: { name: text() } },
                    posts: { fields: { author: relation('authors'), title: text() } },
                },
            }),
            database: db,
            id: () => `id_${String(++id).padStart(3, '0')}`,
            now: () => new Date(time++),
        })
        const author = await admin.createEntry('authors', { data: { name: 'Ada' } })
        const post = await admin.createEntry('posts', { data: { author: author.id, title: 'One' } })
        const published = await admin.publishEntry(post.id, { expectedVersion: post.version })
        const edited = await admin.updateEntry(post.id, { data: { title: 'Two' }, expectedVersion: published.version })
        expect(await admin.referencesTo(author.id, { view: 'current' })).toEqual([])
        expect(await admin.referencesTo(author.id, { view: 'published' })).toMatchObject([
            { entryId: post.id, field: 'author', model: 'posts', view: 'published' },
        ])
        const original = (await admin.listRevisions(post.id)).at(-1)!
        const restored = await admin.restoreRevision(post.id, original.id, { expectedVersion: edited.version })
        expect(restored.data).toMatchObject({ title: 'One' })
        expect(restored.revisionId).not.toBe(original.id)
        const pruned = await admin.pruneRevisions(post.id, 1)
        expect(pruned.deleted.length).toBeGreaterThan(0)
        const retained = await admin.listRevisions(post.id)
        expect(retained.map((revision) => revision.id)).toEqual(
            expect.arrayContaining([restored.revisionId, published.publishedRevisionId]),
        )
    })

    it('stores locale routes independently and filters sitemap/llms options', async () => {
        const db = database()
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                models: {
                    pages: { fields: { title: text() }, localized: true, route: true },
                    hidden: {
                        fields: { title: text() },
                        publishing: false,
                        route: { llms: false, sitemap: false },
                    },
                },
            }),
            database: db,
            locales: {
                defaultLocale: 'en',
                localizePath: (path, locale) => `/${locale}${path}`,
                supported: ['en', 'ja'],
            },
        })
        const en = await admin.createEntry('pages', {
            data: { title: 'English' },
            locale: 'en',
            translationGroup: 'home',
        })
        const ja = await admin.createEntry('pages', {
            data: { title: '日本語' },
            locale: 'ja',
            translationGroup: 'home',
        })
        await admin.publishEntry(en.id, { expectedVersion: en.version })
        await admin.publishEntry(ja.id, { expectedVersion: ja.version })
        await admin.createEntry('hidden', { data: { title: 'Excluded' } })
        expect(await admin.getPublicEntry('pages', 'english')).toMatchObject({ locale: 'en' })
        expect(await admin.getPublicEntry('pages', '日本語', 'ja')).toMatchObject({ locale: 'ja' })
        expect(await admin.resolvePath('/ja/pages/日本語', 'ja')).toMatchObject({
            entry: { alternates: expect.arrayContaining([{ locale: 'en', path: '/en/pages/english' }]) },
            kind: 'page',
        })
        expect((await admin.sitemap()).map((entry) => entry.loc)).not.toContain('/hidden/excluded')
        expect(await admin.llms()).not.toContain('Excluded')
    })
})

describe('v0.1 authorization and assets', () => {
    it('grants only explicit roles and filters descriptors', async () => {
        const db = database()
        const config = defineSiteAdminConfig({
            authorization: defineSiteAdminAuthorization({
                editor: { models: { posts: ['create', 'readDraft'] } },
                reader: { models: { secrets: ['readDraft'] } },
            }),
            models: {
                posts: { fields: { title: text() } },
                secrets: { fields: { title: text() }, public: false },
            },
        })
        const requestAs = async (roles: string[]) =>
            await createMigratedTestAdmin({ authorize: () => ({ id: 'user', roles }), config, database: db })
        const editor = await requestAs(['editor'])
        const descriptor = await handleManagementRequest(editor, new Request('http://localhost/api/site-admin/models'))
        expect(Object.keys(((await descriptor.json()) as { models: object }).models)).toEqual(['posts'])
        const created = await handleManagementRequest(
            editor,
            new Request('http://localhost/api/site-admin/entries/posts', {
                body: JSON.stringify({ data: { title: 'Allowed' } }),
                headers: { 'content-type': 'application/json' },
                method: 'POST',
            }),
        )
        expect(created.status).toBe(201)
        const denied = await handleManagementRequest(
            await requestAs(['user']),
            new Request('http://localhost/api/site-admin/entries/posts', {
                body: JSON.stringify({ data: { title: 'Denied' } }),
                method: 'POST',
            }),
        )
        expect(denied.status).toBe(403)
    })

    it('sniffs upload bytes and serves public assets with revalidation and safe attachment headers', async () => {
        const db = database()
        const files = new Files({ adapter: memory() })
        const download = files.download.bind(files)
        Object.defineProperty(files, 'download', {
            value: (...args: Parameters<typeof download>) => {
                expect(args[1]?.as).toBe('stream')
                return download(...args)
            },
        })
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                assets: { storage: 'current' },
                models: { downloads: { fields: { attachment: file() }, publishing: false } },
            }),
            database: db,
            getFiles: async () => files,
        })
        const asset = await admin.uploadAsset({
            body: '<html>unsafe</html>',
            contentType: 'image/png',
            filename: 'fake.png',
        })
        expect(asset.contentType).toBe('application/octet-stream')
        const entry = await admin.createEntry('downloads', { data: { attachment: asset.id } })
        const url = `http://localhost/api/content/_assets/${asset.id}`
        const response = await handlePublicRequest(admin, new Request(url))
        expect(response.headers.get('cache-control')).toBe('public, no-cache')
        expect(response.headers.get('content-disposition')).toContain('attachment')
        expect(response.headers.get('content-security-policy')).toContain('sandbox')
        expect(response.headers.get('access-control-allow-methods')).toBe('GET, HEAD')
        expect(await response.text()).toBe('<html>unsafe</html>')
        const etag = response.headers.get('etag')!
        expect(
            (await handlePublicRequest(admin, new Request(url, { headers: { 'if-none-match': etag } }))).status,
        ).toBe(304)
        const head = await handlePublicRequest(admin, new Request(url, { method: 'HEAD' }))
        expect(await head.text()).toBe('')
        await admin.unpublishEntry(entry.id, { expectedVersion: entry.version })
        expect((await handlePublicRequest(admin, new Request(url))).status).toBe(404)
    })

    it('reclaims an expired upload lease and rejects the old worker completion without leaving a Blob', async () => {
        const db = database()
        const files = new Files({ adapter: memory() })
        const originalUpload = files.upload.bind(files)
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        Object.defineProperty(files, 'upload', {
            value: async (...args: Parameters<typeof originalUpload>) => {
                await gate
                return originalUpload(...args)
            },
        })
        let now = Date.parse('2026-01-01T00:00:00.000Z')
        const admin = await createMigratedTestAdmin({
            config: defineSiteAdminConfig({
                assets: { operationLeaseSeconds: 1, cleanup: { minimumAge: 0 }, storage: 'content' },
                models: {},
            }),
            database: db,
            getFiles: async () => files,
            now: () => new Date(now),
        })
        await admin.initialize()
        const upload = admin.uploadAsset({
            body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
            filename: 'late.png',
        })
        let row: { id: string; key: string } | undefined
        for (let attempt = 0; attempt < 50 && !row; attempt += 1) {
            row = await queryRow(
                await testAdapter(db, { models: {} }),
                "SELECT id, key FROM site_admin_assets WHERE state = 'uploading'",
            )
            if (!row) await new Promise((resolve) => setTimeout(resolve, 1))
        }
        expect(row).toBeDefined()
        now += 1_001
        expect(await admin.runAssetGC()).toEqual({ deleted: [row!.id], failed: [] })
        release()
        await expect(upload).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        expect(await files.exists(row!.key)).toBe(false)
    })

    it('keeps token guards inside the D1/SQLite atomic mutation', async () => {
        const db = database()
        await (
            await createMigratedTestAdmin({ config: defineSiteAdminConfig({ models: {} }), database: db })
        ).initialize()
        await runAtomic(await testAdapter(db, { models: {} }), [
            {
                params: [
                    'asset',
                    'storage',
                    'key',
                    'application/octet-stream',
                    1,
                    '{}',
                    'uploading',
                    'new',
                    '2099',
                    'now',
                    'now',
                ],
                sql: `INSERT INTO site_admin_assets(
                    id, storage, key, content_type, size, metadata, state, operation_token, lease_expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            },
        ])
        await expect(
            runAtomic(await testAdapter(db, { models: {} }), [
                {
                    expectRow: true,
                    params: ['asset', 'old'],
                    query: true,
                    sql: "UPDATE site_admin_assets SET state = 'ready' WHERE id = ? AND operation_token = ? RETURNING id",
                },
            ]),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
    })
})
