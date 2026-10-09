import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import cloudflareD1 from 'db0/connectors/cloudflare-d1'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { SiteAdminDatabase, SiteAdminStorage } from '../packages/site-admin/src/adapter'
import type { SiteAdminConfig } from '../packages/site-admin/src/config'
import { Files } from 'files-sdk'
import { memory } from 'files-sdk/memory'
import { createSiteAdmin, handleManagementRequest } from '../packages/site-admin/src/server'
import { defineSiteAdminConfig, text, file, relation, array } from '../packages/site-admin/src'
import { migrateTestDatabase, testAdapter } from './migrate'
import { createMemoryDatabase } from './memory-storage'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
})
const config = defineSiteAdminConfig({
    assets: { storage: 'content' },
    authorization: { roles: { reader: { models: { posts: ['readDraft'] } } } },
    models: {
        posts: {
            fields: {
                title: text({ required: true }),
                attachment: file(),
                parent: relation('parents'),
                links: array(relation('parents')),
            },
            route: '/posts/:slug',
            sortable: true,
            localized: true,
        },
        parents: { fields: { title: text({ required: true }) }, route: '/parents/:slug' },
        dependencies: {
            fields: {
                requiredParent: relation('parents', { required: true }),
                optionalParent: relation('parents'),
            },
        },
        secrets: { fields: { title: text() }, public: false },
    },
})
async function backend(
    kind: 'memory' | 'sqlite' | 'd1',
    definition: SiteAdminConfig = config,
): Promise<SiteAdminDatabase> {
    if (kind === 'memory') return createMemoryDatabase()
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    cleanup.push(() => database.dispose())
    await migrateTestDatabase(database, definition)
    if (kind === 'sqlite') return testAdapter(database, definition)
    const native = (await database.getInstance()) as DatabaseSync
    class Statement {
        params: SQLInputValue[] = []
        constructor(readonly sql: string) {}
        bind(...params: SQLInputValue[]) {
            if (params.length > 100) throw Error('D1 bound parameter limit')
            this.params = params
            return this
        }
        async all() {
            return { results: native.prepare(this.sql).all(...this.params), success: true }
        }
    }
    const binding = {
        prepare: (sql: string) => new Statement(sql),
        async batch(statements: Statement[]) {
            native.exec('BEGIN IMMEDIATE')
            try {
                const results = statements.map((statement) => ({
                    results: native.prepare(statement.sql).all(...statement.params),
                    success: true,
                }))
                native.exec('COMMIT')
                return results
            } catch (error) {
                native.exec('ROLLBACK')
                throw error
            }
        },
    }
    Object.assign(globalThis, { __env__: { CONFORMANCE_DB: binding } })
    const d1 = createDatabase(cloudflareD1({ bindingName: 'CONFORMANCE_DB' }))
    cleanup.push(() => d1.dispose())
    return testAdapter(d1, definition)
}
async function setup(kind: 'memory' | 'sqlite' | 'd1') {
    const database = await backend(kind),
        storage = database.bind(config)
    let clock = new Date('2026-10-09T10:00:00Z'),
        id = 0
    const core = createSiteAdmin({
        config,
        database: { bind: () => storage },
        id: () => `id-${++id}`,
        now: () => clock,
        locales: { defaultLocale: 'en', supported: ['en', 'ja'] },
        authorize: () => ({ id: 'reader', roles: ['reader'] }),
    })
    await core.initialize()
    return {
        core,
        storage,
        tick: () => {
            clock = new Date(clock.getTime() + 1000)
        },
    }
}
async function graph(storage: SiteAdminStorage) {
    const entries = await storage.entries()
    return {
        entries,
        revisions: await Promise.all(entries.map((entry) => storage.revisions(entry.id))),
        routes: await storage.routes(),
        generation: await storage.publicGeneration(),
        references: await Promise.all(
            entries.map((entry) => storage.incomingReferences(entry.id, { view: 'current' })),
        ),
    }
}
for (const kind of ['memory', 'sqlite', 'd1'] as const)
    describe(`${kind} domain storage conformance`, () => {
        it('synchronizes public changes and a scheduled batch once while preserving each lifecycle hook', async () => {
            const events: string[] = []
            const definition = defineSiteAdminConfig({
                assets: { storage: 'content', separateDrafts: true },
                hooks: {
                    afterCommit: (event) => {
                        events.push(event.type)
                    },
                },
                models: {
                    posts: { fields: { title: text() }, route: '/posts/:slug' },
                    auto: { fields: { title: text() }, publishing: false },
                    private: { fields: { title: text() }, publishing: false, public: false },
                },
            })
            const storage = (await backend(kind, definition)).bind(definition)
            const stores = { draft: new Files({ adapter: memory() }), content: new Files({ adapter: memory() }) }
            const core = createSiteAdmin({
                config: definition,
                database: { bind: () => storage },
                getFiles: async (name) => (name === 'draft' ? stores.draft : stores.content),
                now: () => new Date('2026-10-09T10:00:00Z'),
            })
            await core.initialize()
            let syncs = 0
            const claim = storage.claimAssetSync.bind(storage)
            storage.claimAssetSync = (...args) => {
                syncs++
                return claim(...args)
            }
            let draft = await core.createEntry('posts', { slug: 'first', data: { title: 'First' } })
            const original = draft.revisionId
            draft = await core.updateEntry(draft.id, { expectedVersion: draft.version, data: { title: 'Edit' } })
            draft = await core.restoreRevision(draft.id, original, { expectedVersion: draft.version })
            draft = await core.schedulePublish(draft.id, { expectedVersion: draft.version, at: '2026-10-09T12:00:00Z' })
            draft = await core.cancelScheduledPublish(draft.id, { expectedVersion: draft.version })
            await core.pruneRevisions(draft.id, 0)
            let privateEntry = await core.createEntry('private', { data: { title: 'Private' } })
            privateEntry = await core.updateEntry(privateEntry.id, { expectedVersion: privateEntry.version, data: {} })
            privateEntry = await core.unpublishEntry(privateEntry.id, { expectedVersion: privateEntry.version })
            privateEntry = await core.publishEntry(privateEntry.id, { expectedVersion: privateEntry.version })
            await core.deleteEntry(privateEntry.id, { expectedVersion: privateEntry.version })
            expect(await core.publicGeneration()).toBe(0)
            expect(syncs).toBe(0)
            let auto = await core.createEntry('auto', { data: { title: 'Auto' } })
            auto = await core.updateEntry(auto.id, { expectedVersion: auto.version, data: {} })
            expect(syncs).toBe(2)
            expect(await core.publicGeneration()).toBe(2)
            draft = await core.schedulePublish(draft.id, { expectedVersion: draft.version, at: '2026-10-09T12:00:00Z' })
            const second = await core.createEntry('posts', { slug: 'second', data: { title: 'Second' } })
            await core.schedulePublish(second.id, { expectedVersion: second.version, at: '2026-10-09T12:00:00Z' })
            const publishes = events.filter((event) => event === 'publish').length
            expect((await core.publishDue(new Date('2026-10-09T13:00:00Z'))).published.sort()).toEqual(
                [draft.id, second.id].sort(),
            )
            expect(syncs).toBe(3)
            expect(events.filter((event) => event === 'publish')).toHaveLength(publishes + 2)
            expect(await core.publicGeneration()).toBe(4)
        })
        it('keeps draft slugs semantic, validates publication and preserves raw records', async () => {
            const { core } = await setup(kind)
            let entry = await core.createEntry('posts', { slug: '', data: { title: 'Draft' } })
            expect(entry.slug).toBe('')
            expect((await core.listRevisions(entry.id))[0]?.slug).toBe('')
            await expect(core.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
                code: 'SITE_ADMIN_INVALID_INPUT',
            })
            entry = await core.publishEntry(entry.id, {
                expectedVersion: entry.version,
                draft: { slug: 'live', data: { title: 'Published' } },
            })
            expect(entry.version).toBe(2)
            expect((await core.getPublicEntry('posts', 'live', 'en'))?.data.title).toBe('Published')
            expect((await core.getEntry(entry.id)).data.title).toBe('Published')
        })
        it('rolls back stale candidates, revision references, route changes and generation together', async () => {
            const { core, storage } = await setup(kind)
            const parent = await core.createEntry('parents', { data: { title: 'Parent' } })
            let entry = await core.createEntry('posts', { slug: 'first', data: { title: 'First' } })
            entry = await core.publishEntry(entry.id, { expectedVersion: entry.version })
            const before = await graph(storage)
            await expect(
                core.publishEntry(entry.id, {
                    expectedVersion: 0,
                    draft: { slug: 'stale', data: { title: 'Stale', parent: parent.id } },
                }),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
            expect(await graph(storage)).toEqual(before)
            expect(await core.resolvePath('/posts/stale', 'en')).toBeNull()
        })
        it('rolls back a conflicting route without leaving a candidate revision', async () => {
            const { core, storage } = await setup(kind)
            let first = await core.createEntry('posts', { slug: 'taken', data: { title: 'First' } })
            first = await core.publishEntry(first.id, { expectedVersion: first.version })
            const second = await core.createEntry('posts', { slug: 'second', data: { title: 'Second' } })
            const before = await graph(storage)
            await expect(
                core.publishEntry(second.id, {
                    expectedVersion: second.version,
                    draft: { slug: 'taken', data: { title: 'Rejected' } },
                }),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_ROUTE_CONFLICT' })
            expect(await graph(storage)).toEqual(before)
        })
        it('rejects a missing update target before applying any independent candidate', async () => {
            const { core, storage } = await setup(kind)
            const entry = await core.createEntry('posts', { data: { title: 'Before' } })
            const before = await graph(storage)
            await expect(
                storage.commit({
                    revisions: [
                        {
                            id: 'candidate',
                            entryId: entry.id,
                            model: 'posts',
                            actorId: null,
                            createdAt: entry.createdAt,
                            slug: '',
                            data: { title: 'Rejected' },
                            assets: [],
                            relations: [],
                        },
                    ],
                    updates: [{ id: 'missing', patch: {} }],
                    publicGeneration: true,
                }),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
            expect(await graph(storage)).toEqual(before)
        })
        it('guards every reorder against the same state and handles D1-sized sets', async () => {
            const { core, storage } = await setup(kind)
            const entries = []
            for (let index = 0; index < 45; index++)
                entries.push(await core.createEntry('posts', { data: { title: `Post ${index}` } }))
            const items = entries.map((entry, index) => ({
                id: entry.id,
                sortOrder: index,
                expectedVersion: entry.version,
            }))
            const before = await graph(storage)
            await expect(
                core.setSortOrders(
                    'posts',
                    items.map((item, index) => (index === 44 ? { ...item, expectedVersion: 0 } : item)),
                ),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
            expect(await graph(storage)).toEqual(before)
            const sorted = await core.setSortOrders('posts', items)
            expect(sorted.map(({ sortOrder }) => sortOrder)).toEqual(items.map(({ sortOrder }) => sortOrder))
            expect(await core.publicGeneration()).toBe(0)
        })
        it('filters authorized models, locale and search before paging and counts empty pages', async () => {
            const { core, storage, tick } = await setup(kind)
            await core.createEntry('secrets', { data: { title: 'Needle private' } })
            for (const [locale, title] of [
                ['ja', 'Needle Japanese'],
                ['en', 'Other'],
                ['en', 'Needle one'],
                ['en', 'Needle two'],
            ] as const) {
                tick()
                await core.createEntry('posts', { locale, data: { title } })
            }
            const original = core.listEntries.bind(core)
            core.listEntries = async () => {
                throw Error('Management must use adapter paging')
            }
            const response = await handleManagementRequest(
                core,
                new Request('https://example.test/manage/entries?locale=en&q=needle&limit=1&offset=1'),
                '/manage',
            )
            expect(response.status).toBe(200)
            const body = await response.json()
            expect(body.total).toBe(2)
            expect(body.items).toHaveLength(1)
            expect(body.items[0].data.title).toBe('Needle one')
            expect(
                await storage.pageEntries({ models: ['posts'], locale: 'en', q: 'needle' }, { limit: 1, offset: 20 }),
            ).toEqual({ items: [], total: 2 })
            expect(await storage.pageEntries({ models: [] }, { limit: 1, offset: 0 })).toEqual({ items: [], total: 0 })
            core.listEntries = original
        })
        it('pins scheduled revisions, protects pointers while pruning and blocks retained references', async () => {
            const { core } = await setup(kind)
            const parent = await core.createEntry('parents', { data: { title: 'Parent' } })
            let entry = await core.createEntry('posts', {
                slug: 'post',
                data: { title: 'Scheduled', parent: parent.id },
            })
            const pinned = entry.revisionId
            entry = await core.schedulePublish(entry.id, { expectedVersion: entry.version, at: '2026-10-09T12:00:00Z' })
            entry = await core.updateEntry(entry.id, { expectedVersion: entry.version, data: { title: 'Newer' } })
            expect(await core.pruneRevisions(entry.id, 0)).toEqual({ deleted: [] })
            expect((await core.publishDue(new Date('2026-10-09T13:00:00Z'))).published).toEqual([entry.id])
            expect((await core.getEntry(entry.id)).publishedRevisionId).toBe(pinned)
            expect((await core.getPublicEntry('posts', 'post', 'en'))?.data.title).toBe('Scheduled')
            await expect(core.deleteEntry(parent.id, { expectedVersion: parent.version })).rejects.toMatchObject({
                code: 'SITE_ADMIN_RELATION_BLOCKED',
            })
            entry = await core.getEntry(entry.id)
            await core.deleteEntry(entry.id, { expectedVersion: entry.version })
            await core.deleteEntry(parent.id, { expectedVersion: parent.version })
            expect(await core.listEntries()).toEqual([])
        })
        it('keeps a required publication guard when an optional field references the same target', async () => {
            const { core, storage } = await setup(kind)
            let parent = await core.createEntry('parents', { slug: 'parent', data: { title: 'Parent' } })
            parent = await core.publishEntry(parent.id, { expectedVersion: parent.version })
            const entry = await core.createEntry('dependencies', {
                data: { requiredParent: parent.id, optionalParent: parent.id },
            })
            const commit = storage.commit.bind(storage)
            storage.commit = async (input) => {
                await commit({
                    conditions: [{ kind: 'entryVersion', id: parent.id, version: parent.version }],
                    updates: [{ id: parent.id, patch: { publishedRevisionId: null, publishedAt: null } }],
                    publicGeneration: true,
                })
                return commit(input)
            }
            const generation = await core.publicGeneration()
            await expect(core.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
                code: 'SITE_ADMIN_CONFLICT',
            })
            expect(await core.getEntry(entry.id)).toEqual(entry)
            expect(await core.listRevisions(entry.id)).toHaveLength(1)
            expect(await core.publicGeneration()).toBe(generation + 1)
        })
        it('handles reference and prune sets larger than the D1 parameter limit', async () => {
            const { core, storage, tick } = await setup(kind)
            const parents = []
            for (let index = 0; index < 105; index++)
                parents.push(await core.createEntry('parents', { data: { title: `Parent ${index}` } }))
            let entry = await core.createEntry('posts', {
                data: { title: 'References', links: parents.map(({ id }) => id) },
            })
            expect(await storage.incomingReferences(parents[104]!.id, { view: 'current' })).toHaveLength(1)
            for (let index = 0; index < 105; index++) {
                tick()
                entry = await core.updateEntry(entry.id, {
                    expectedVersion: entry.version,
                    data: { title: `Revision ${index}` },
                })
            }
            expect((await core.pruneRevisions(entry.id, 0)).deleted).toHaveLength(105)
            expect(await core.listRevisions(entry.id)).toHaveLength(1)
            expect(await storage.incomingReferences(parents[104]!.id, { view: 'current' })).toEqual([])
            expect(await storage.hasRetainedRelations(parents[104]!.id)).toBe(false)
        })
        it('rechecks Asset readiness inside commit and leaves no revision or Asset reference on conflict', async () => {
            const { core, storage } = await setup(kind)
            const now = '2026-10-09T10:00:00.000Z'
            await storage.insertAsset({
                id: 'asset',
                key: 'original',
                storage: 'content',
                contentType: 'text/plain',
                size: 1,
                checksum: null,
                metadata: {},
                state: 'ready',
                operationToken: null,
                leaseExpiresAt: null,
                createdAt: now,
                updatedAt: now,
            })
            const entry = await core.createEntry('posts', { data: { title: 'Before' } })
            const before = await graph(storage),
                commit = storage.commit.bind(storage)
            storage.commit = async (input) => {
                await storage.claimAssetDeletion('asset', 'token', '2026-10-09T11:00:00Z', now)
                return commit(input)
            }
            await expect(
                core.updateEntry(entry.id, {
                    expectedVersion: entry.version,
                    data: { title: 'After', attachment: { id: 'asset' } },
                }),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
            expect(await graph(storage)).toEqual(before)
            expect(await storage.hasAssetReferences('asset')).toBe(false)
        })
        it('enforces upload/delete tokens, sync lease ownership, generation and durable tombstones', async () => {
            const { storage } = await setup(kind),
                now = '2026-10-09T10:00:00.000Z'
            await storage.insertAsset({
                id: 'asset',
                key: 'original',
                storage: 'draft',
                contentType: 'text/plain',
                size: 1,
                checksum: null,
                metadata: {},
                state: 'uploading',
                operationToken: 'upload',
                leaseExpiresAt: '2026-10-09T11:00:00Z',
                createdAt: now,
                updatedAt: now,
            })
            expect(
                await storage.finishAssetUpload(
                    'asset',
                    'other',
                    { contentType: 'text/plain', size: 1, checksum: 'hash' },
                    now,
                ),
            ).toBe(false)
            expect(
                await storage.finishAssetUpload(
                    'asset',
                    'upload',
                    { contentType: 'text/plain', size: 1, checksum: 'hash' },
                    now,
                ),
            ).toBe(true)
            const lease = { id: 'owner', expiresAt: '2026-10-09T11:00:00Z' },
                guard = { lease, now, generation: 0 }
            const copy = { assetId: 'asset', key: 'public', storage: 'content', state: 'copying' as const }
            expect(await storage.claimAssetSync(lease, now)).toBe(true)
            expect(await storage.claimAssetSync({ id: 'other', expiresAt: lease.expiresAt }, now)).toBe(false)
            expect(await storage.createAssetCopy('opaque', copy, guard)).toBe(true)
            await storage.commit({ publicGeneration: true })
            expect(await storage.updateAssetCopy('opaque', { ...copy, state: 'ready' }, guard)).toBe(false)
            expect(await storage.updateAssetCopy('opaque', { ...copy, state: 'retired' }, { lease, now })).toBe(true)
            await storage.releaseAssetSync({ id: 'other', expiresAt: lease.expiresAt })
            expect(await storage.updateAssetCopy('opaque', copy, { lease, now })).toBe(true)
            await storage.releaseAssetSync(lease)
            expect(await storage.updateAssetCopy('opaque', copy, { lease, now })).toBe(false)
            expect(await storage.claimAssetDeletion('asset', 'delete', '2026-10-09T11:00:00Z', now)).toBe(true)
            expect(await storage.finishAssetDeletion('asset', 'other', true, now)).toBe(false)
            expect(await storage.finishAssetDeletion('asset', 'delete', true, now)).toBe(true)
            expect(await storage.assetCopies()).toHaveLength(1)
        })
    })
