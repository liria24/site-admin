import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { effectScope } from 'vue'
import {
    array,
    createSiteAdminDescriptor,
    defineSiteAdminConfig,
    object,
    select,
    text,
    type InferSiteAdminFormModels,
    type InferSiteAdminModels,
} from '../packages/site-admin/src'
import { createSiteAdminManagementClient } from '../packages/site-admin/src/client'
import { useSiteAdminForm } from '../packages/site-admin/src/form'
import { createSiteAdmin, handleManagementRequest } from '../packages/site-admin/src/server'
import { migrateTestDatabase, testAdapter } from './migrate'

const original = defineSiteAdminConfig({
    models: {
        posts: {
            route: '/posts/:slug',
            fields: {
                title: text({ required: true }),
                excerpt: text(),
                publication: object({ slug: select(['auto', 'manual']), excerpt: text() }),
                sections: array(array(object({ heading: text(), retired: text() }))),
            },
        },
    },
})
const current = defineSiteAdminConfig({
    models: {
        posts: {
            route: '/posts/:slug',
            fields: {
                title: text({ required: true }),
                publication: object({ slug: select(['auto', 'manual'], { required: true }) }),
                sections: array(array(object({ heading: text() }))),
            },
        },
    },
})
type Data = InferSiteAdminFormModels<typeof current>['posts']
const databases: Database[] = []
afterEach(async () => Promise.all(databases.splice(0).map((db) => db.dispose())))
const fixture = async (oldMapping: boolean) => {
    const db = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(db)
    await migrateTestDatabase(db, original)
    const legacy = createSiteAdmin({ config: original, database: await testAdapter(db, original) })
    const created = await legacy.createEntry('posts', {
        slug: 'synthetic',
        data: {
            title: 'Stored',
            excerpt: 'Historical',
            publication: { slug: 'manual', excerpt: 'auto' },
            sections: [[{ heading: 'Heading', retired: 'Nested historical' }]],
        },
    })
    const entry = await legacy.publishEntry(created.id, { expectedVersion: created.version })
    const admin = createSiteAdmin({
        config: current,
        database: await testAdapter(db, oldMapping ? original : current),
        authorize: () => ({ id: 'synthetic-admin', roles: ['admin'] }),
    })
    const client = createSiteAdminManagementClient<InferSiteAdminModels<typeof current>>({
        origin: 'http://fixture.test',
        fetch: (input, init) => handleManagementRequest(admin, new Request(input, init)),
    })
    const history = () => db.prepare('SELECT * FROM site_admin_content_posts WHERE revision_id=?').get(entry.revisionId)
    return { db, admin, client, entry, history }
}

describe('trusted stored management snapshots', () => {
    it.each([false, true])(
        'edits, restores and republishes old snapshots without rewriting history (old mapping: %s)',
        async (oldMapping) => {
            const { admin, client, entry, history } = await fixture(oldMapping)
            const originalRow = await history()
            const raw = await admin.getEntry(entry.id)
            expect(raw.data.publication).toEqual({ slug: 'manual', excerpt: 'auto' })
            expect((await admin.listRevisions(entry.id))[0]?.data.publication).toEqual(raw.data.publication)
            const read = await client.getEntry(entry.id)
            const projected = { title: 'Stored', publication: { slug: 'manual' }, sections: [[{ heading: 'Heading' }]] }
            expect(read.data).toEqual(projected)
            expect((await client.listEntries('posts')).items[0]?.data).toEqual(projected)
            expect((await client.listRevisions(entry.id))[0]?.data).toEqual(projected)
            const scope = effectScope()
            try {
                // A Core raw DTO passed directly to the existing form overload is also a trusted initial snapshot.
                const form = scope.run(() =>
                    useSiteAdminForm<Data>({
                        descriptor: createSiteAdminDescriptor(current).models.posts!,
                        modelName: 'posts',
                        entry: raw,
                        origin: 'http://fixture.test',
                        fetch: (input, init) => handleManagementRequest(admin, new Request(input, init)),
                    }),
                )!
                expect(form.form.state.values).toEqual(projected)
                expect(form.dirty.value).toBe(false)
                form.form.setFieldValue('title', 'Edited')
                await form.form.handleSubmit()
                expect(form.serverError.value).toBeNull()
                expect(form.dirty.value).toBe(false)
                expect((await admin.getEntry(entry.id)).data.title).toBe('Edited')
                expect((await admin.getEntry(entry.id)).publishedRevisionId).toBe(entry.publishedRevisionId)
                const version = (await admin.getEntry(entry.id)).version
                await client.restoreRevision(entry.id, entry.revisionId, { expectedVersion: version })
                const restored = await admin.getEntry(entry.id)
                expect(restored.currentRevisionId).not.toBe(entry.currentRevisionId)
                expect(restored.data.publication).toEqual({ slug: 'manual' })
                expect(restored.data.sections).toEqual([[{ heading: 'Heading' }]])
                await form.refresh()
                expect(form.form.state.values).toEqual(projected)
                expect(form.baseVersion.value).toBe(restored.version)
                await client.publishEntry(entry.id, { expectedVersion: restored.version, revisionId: entry.revisionId })
                expect((await admin.getEntry(entry.id)).publishedRevisionId).toBe(entry.revisionId)
                expect((await admin.getPublicEntry('posts', entry.id))?.data).toEqual(projected)
                expect(await history()).toEqual(originalRow)
                expect(
                    (await admin.listRevisions(entry.id)).find((revision) => revision.id === entry.revisionId)?.data
                        .publication,
                ).toEqual({ slug: 'manual', excerpt: 'auto' })
            } finally {
                scope.stop()
            }
        },
    )

    it('rejects retired or unrelated fields in new HTTP payloads and preserves all pointers on failure', async () => {
        const { admin, client, entry, history } = await fixture(false)
        const before = await admin.getEntry(entry.id)
        const originalRow = await history()
        for (const data of [
            { title: 'New', excerpt: 'Retired' },
            { title: 'New', publication: { slug: 'manual', excerpt: 'auto' } },
            { title: 'New', sections: [[{ heading: 'Heading', retired: 'Injected' }]] },
            { title: 'New', unrelated: true },
        ]) {
            const request = (method: string, suffix: string, body: object) =>
                handleManagementRequest(
                    admin,
                    new Request('http://fixture.test/api/site-admin/' + suffix, {
                        method,
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(body),
                    }),
                )
            for (const response of [
                await request('POST', 'entries/posts', { data }),
                await request('PATCH', 'entries/' + entry.id, { expectedVersion: entry.version, data }),
            ]) {
                expect(response.status).toBe(400)
                expect(await response.json()).toMatchObject({ error: { code: 'SITE_ADMIN_INVALID_INPUT' } })
            }
        }
        await expect(
            client.restoreRevision(entry.id, entry.revisionId, { expectedVersion: entry.version - 1 }),
        ).rejects.toMatchObject({ status: 409 })
        expect(await admin.getEntry(entry.id)).toEqual(before)
        expect(await history()).toEqual(originalRow)
    })

    it.each([
        ['publication', { excerpt: 'auto' }],
        ['publication', { slug: 42, excerpt: 'auto' }],
        ['publication', { slug: 'invalid', excerpt: 'auto' }],
        ['publication', 'invalid shape'],
        ['sections', [[{ heading: 42, retired: 'old' }]]],
    ])('does not launder invalid active stored values: %s %j', async (name, value) => {
        const { db, admin, client, entry, history } = await fixture(false)
        await db
            .prepare('UPDATE site_admin_content_posts SET field_' + name + '=? WHERE revision_id=?')
            .bind(JSON.stringify(value), entry.revisionId)
            .run()
        const before = await admin.getEntry(entry.id)
        const originalRow = await history()
        await expect(
            client.restoreRevision(entry.id, entry.revisionId, { expectedVersion: entry.version }),
        ).rejects.toMatchObject({ status: 400 })
        await expect(
            client.publishEntry(entry.id, { expectedVersion: entry.version, revisionId: entry.revisionId }),
        ).rejects.toMatchObject({ status: 400 })
        expect(await admin.getEntry(entry.id)).toEqual(before)
        expect(await history()).toEqual(originalRow)
    })
})
