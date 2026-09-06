import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { Files } from 'files-sdk'
import { memory } from 'files-sdk/memory'

import {
    array,
    boolean,
    defineSiteAdminConfig,
    image,
    markdown,
    model,
    object,
    relation,
    text,
    url,
} from '../packages/site-admin/src'
import {
    createSiteAdmin,
    handleManagementRequest,
    handlePublicRequest,
    type SiteAdmin,
} from '../packages/site-admin/src/server'

const databases: Database[] = []

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const setup = (): {
    admin: SiteAdmin
    advance: (milliseconds: number) => void
    files: Files
} => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    const files = new Files({ adapter: memory() })
    let sequence = 0
    let time = Date.parse('2026-01-01T00:00:00.000Z')
    const config = defineSiteAdminConfig({
        assets: { maxUploadSize: 32, orphanGracePeriod: '24h', storage: 'content' },
        models: {
            authors: model({ fields: { name: text({ required: true }) } }),
            posts: model({
                fields: {
                    body: markdown(),
                    cover: image(),
                    sections: array(
                        object({ author: relation('authors', { required: true }), heading: text() }),
                    ),
                    title: text({ required: true }),
                },
                route: true,
            }),
            secrets: model({
                fields: { cover: image(), destination: url(), title: text() },
                public: false,
                publishing: false,
                route: { path: '/secrets/:slug', redirect: 'destination' },
            }),
            settings: model({ fields: { enabled: boolean() }, publishing: false }),
        },
    })
    return {
        admin: createSiteAdmin({
            authorize: () => ({ id: 'editor' }),
            config,
            database,
            getFiles: async (name) => {
                expect(name).toBe('content')
                return files
            },
            id: () => `id_${++sequence}`,
            now: () => new Date(time),
        }),
        advance: (milliseconds) => {
            time += milliseconds
        },
        files,
    }
}

describe('SiteAdmin', () => {
    it('keeps drafts private, guards nested relations, and preserves route history', async () => {
        const { admin } = setup()
        const asset = await admin.uploadAsset({
            body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            filename: 'cover.png',
        })
        const author = await admin.createEntry('authors', { data: { name: 'Ada' } })
        const post = await admin.createEntry('posts', {
            data: {
                body: `Intro\n\n<!-- more -->\n\n![](site-admin://asset/${asset.id})`,
                cover: { alt: 'Cover', id: asset.id },
                sections: [{ author: author.id, heading: 'Byline' }],
                title: 'First Post',
            },
        })

        await expect(admin.publishEntry(post.id, { expectedVersion: post.version })).rejects.toMatchObject({
            code: 'SITE_ADMIN_RELATION_BLOCKED',
        })
        await expect(admin.downloadAsset(asset.id, true)).rejects.toMatchObject({
            code: 'SITE_ADMIN_NOT_PUBLIC',
        })

        const publishedAuthor = await admin.publishEntry(author.id, { expectedVersion: author.version })
        const publishedPost = await admin.publishEntry(post.id, { expectedVersion: post.version })
        const firstGeneration = await admin.publicGeneration()
        const firstPublic = await admin.getPublicEntry('posts', 'first-post')

        expect(firstPublic).toMatchObject({
            data: {
                cover: { alt: 'Cover', id: asset.id, url: `/api/content/_assets/${asset.id}` },
                sections: [{ author: { data: { name: 'Ada' }, id: author.id }, heading: 'Byline' }],
                title: 'First Post',
            },
            path: '/posts/first-post',
        })
        expect(firstPublic?.data.body as string).toContain(`/api/content/_assets/${asset.id}`)
        await expect(admin.downloadAsset(asset.id, true)).resolves.toMatchObject({ asset: { id: asset.id } })

        const draft = await admin.updateEntry(post.id, {
            data: { ...publishedPost.data, title: 'Changed' },
            expectedVersion: publishedPost.version,
            slug: 'changed',
        })
        expect(await admin.publicGeneration()).toBe(firstGeneration)
        expect(await admin.getPublicEntry('posts', 'first-post')).toMatchObject({
            data: { title: 'First Post' },
        })
        expect(await admin.getPublicEntry('posts', 'changed')).toBeNull()

        const republished = await admin.publishEntry(post.id, { expectedVersion: draft.version })
        expect(await admin.resolvePath('/posts/first-post')).toEqual({
            kind: 'redirect',
            status: 301,
            target: '/posts/changed',
        })
        expect(await admin.resolvePath('/posts/changed')).toMatchObject({
            entry: { data: { title: 'Changed' } },
            kind: 'page',
        })
        const content = await admin.content('posts')
        expect(await content.list('posts')).toEqual(
            expect.arrayContaining([expect.objectContaining({ path: '/posts/changed' })]),
        )
        expect(await admin.llms()).toContain('[Changed](/posts/changed) — Intro')
        expect(await admin.llms(true)).toContain('## Changed')
        expect(await admin.inspect()).toMatchObject({
            entries: { authors: { published: 1 }, posts: { drafts: 0, published: 1 } },
            orphanAssets: 0,
        })

        await expect(
            admin.updateEntry(post.id, { data: republished.data, expectedVersion: draft.version }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        expect(await admin.listRevisions(post.id)).toHaveLength(2)
        await expect(
            admin.unpublishEntry(author.id, { expectedVersion: publishedAuthor.version }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_RELATION_BLOCKED' })
    })

    it('publishes route-less data without exposing private models or their assets', async () => {
        const { admin } = setup()
        const settings = await admin.createEntry('settings', { data: { enabled: true } })
        expect(await admin.listPublicEntries('settings')).toMatchObject([
            { data: { enabled: true }, id: settings.id, path: null },
        ])

        const privateAsset = await admin.uploadAsset({
            body: 'secret',
            contentType: 'text/plain',
            filename: 'secret.txt',
        })
        await admin.createEntry('secrets', {
            data: {
                cover: privateAsset.id,
                destination: 'https://example.com/private',
                title: 'Hidden',
            },
        })
        await expect(admin.getPublicEntry('secrets', 'hidden')).rejects.toMatchObject({
            code: 'SITE_ADMIN_NOT_PUBLIC',
        })
        expect(await admin.resolvePath('/secrets/hidden')).toBeNull()
        await expect(admin.downloadAsset(privateAsset.id, true)).rejects.toMatchObject({
            code: 'SITE_ADMIN_NOT_PUBLIC',
        })
    })

    it('uses immutable asset keys and only collects unreferenced assets after the grace period', async () => {
        const { admin, advance, files } = setup()
        const first = await admin.uploadAsset({
            body: 'same',
            contentType: 'text/plain',
            filename: '../same.txt',
        })
        const second = await admin.uploadAsset({
            body: 'same',
            contentType: 'text/plain',
            filename: '../same.txt',
        })
        expect(first.key).not.toBe(second.key)

        await admin.createEntry('posts', {
            data: { body: '', cover: first.id, sections: [], title: 'Asset holder' },
        })
        await expect(admin.deleteAsset(first.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_ASSET_IN_USE' })
        expect(await admin.runAssetGC()).toEqual({ deleted: [], failed: [] })

        advance(86_400_001)
        expect(await admin.runAssetGC()).toEqual({ deleted: [second.id], failed: [] })
        expect(await files.exists(first.key)).toBe(true)
        expect(await files.exists(second.key)).toBe(false)
    })

    it('pins the scheduled revision and publishes it through the normal pipeline', async () => {
        const { admin, advance } = setup()
        const entry = await admin.createEntry('authors', { data: { name: 'Scheduled' } })
        const scheduled = await admin.schedulePublish(entry.id, {
            at: '2026-01-01T01:00:00.000Z',
            expectedVersion: entry.version,
        })
        expect(scheduled.scheduledRevisionId).toBe(entry.revisionId)
        await expect(
            admin.cancelScheduledPublish(entry.id, { expectedVersion: entry.version }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })

        const edited = await admin.updateEntry(entry.id, {
            data: { name: 'Newer draft' },
            expectedVersion: scheduled.version,
        })
        expect(edited.scheduledRevisionId).toBe(entry.revisionId)
        advance(3_600_001)
        expect(await admin.publishDue()).toEqual({ failed: [], published: [entry.id] })
        expect(await admin.getPublicEntry('authors', entry.id)).toMatchObject({ data: { name: 'Scheduled' } })
        expect((await admin.getEntry(entry.id)).scheduledRevisionId).toBeNull()
    })

    it('fails management HTTP closed and exposes only published content', async () => {
        const { admin } = setup()
        const unauthorizedDatabase = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(unauthorizedDatabase)
        const unauthorized = createSiteAdmin({
            config: admin.config,
            database: unauthorizedDatabase,
        })

        const denied = await handleManagementRequest(
            unauthorized,
            new Request('http://localhost/api/site-admin/models'),
        )
        expect(denied.status).toBe(401)

        const created = await handleManagementRequest(
            admin,
            new Request('http://localhost/api/site-admin/entries/authors', {
                body: JSON.stringify({ data: { name: 'HTTP' } }),
                headers: { 'content-type': 'application/json' },
                method: 'POST',
            }),
        )
        expect(created.status).toBe(201)
        const draft = (await created.json()) as { id: string; version: number }
        const before = await handlePublicRequest(admin, new Request('http://localhost/api/content/authors'))
        expect(await before.json()).toEqual([])

        await admin.publishEntry(draft.id, { expectedVersion: draft.version })
        const after = await handlePublicRequest(admin, new Request('http://localhost/api/content/authors'))
        expect(after.status).toBe(200)
        expect(await after.json()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    data: expect.objectContaining({
                        _siteAdmin: expect.objectContaining({ id: draft.id }),
                    }),
                }),
            ]),
        )
    })
})
