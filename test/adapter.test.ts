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
import type { DrizzleSiteAdminDatabase } from '../packages/site-admin/src/adapters/drizzle'
import { queryRows, runAtomic } from './sqlite-queries'
import { createSiteAdminManagementClient } from '../packages/site-admin/src/client'

const cleanup: Array<() => Promise<void>> = []
type BatchControls = {
    beforeBatch?: (queries: readonly string[]) => Promise<void>
    otherConnection?: () => Promise<SiteAdminDatabase>
    calls?: number
    maxCalls?: number
    maxValueBytes?: number
    trace?: string[]
}
const batchControls = new WeakMap<SiteAdminDatabase, BatchControls>()
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
    const controls: BatchControls = {}
    const queryCall = (sql: string) => {
        controls.calls = (controls.calls ?? 0) + 1
        controls.trace?.push(sql)
        if (controls.maxCalls !== undefined && controls.calls > controls.maxCalls) throw Error('D1 request query limit')
    }
    class Statement {
        params: SQLInputValue[] = []
        constructor(readonly sql: string) {}
        bind(...params: SQLInputValue[]) {
            if (params.length > 100) throw Error('D1 bound parameter limit')
            if (
                controls.maxValueBytes !== undefined &&
                params.some((value) => typeof value === 'string' && Buffer.byteLength(value) > controls.maxValueBytes!)
            )
                throw Error('D1 string/blob limit')
            this.params = params
            return this
        }
        async all() {
            queryCall(this.sql)
            return { results: native.prepare(this.sql).all(...this.params), success: true }
        }
    }
    const binding = {
        prepare: (sql: string) => new Statement(sql),
        async batch(statements: Statement[]) {
            await controls.beforeBatch?.(statements.map(({ sql }) => sql))
            native.exec('BEGIN IMMEDIATE')
            try {
                const results = statements.map((statement) => {
                    queryCall(statement.sql)
                    return { results: native.prepare(statement.sql).all(...statement.params), success: true }
                })
                native.exec('COMMIT')
                return results
            } catch (error) {
                native.exec('ROLLBACK')
                throw error
            }
        },
    }
    Object.assign(globalThis, { __env__: { CONFORMANCE_DB: binding } })
    controls.otherConnection = async () => {
        const separate = {
            prepare: (sql: string) => binding.prepare(sql),
            batch: (statements: Statement[]) => binding.batch(statements),
        }
        Object.assign(globalThis, { __env__: { CONFORMANCE_DB: binding, CONFORMANCE_WRITER_DB: separate } })
        const other = createDatabase(cloudflareD1({ bindingName: 'CONFORMANCE_WRITER_DB' }))
        cleanup.push(() => other.dispose())
        return testAdapter(other, definition)
    }
    const d1 = createDatabase(cloudflareD1({ bindingName: 'CONFORMANCE_DB' }))
    cleanup.push(() => d1.dispose())
    const adapter = await testAdapter(d1, definition)
    batchControls.set(adapter, controls)
    return adapter
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
        database,
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
        it.each([false, true])(
            'evaluates mixed update/delete candidates against one pre-state (stale: %s)',
            async (stale) => {
                const { core, storage, database } = await setup(kind)
                const a = await core.createEntry('posts', { data: { title: 'Update' } })
                let b = await core.createEntry('posts', { data: { title: 'Delete' } })
                b = await core.updateEntry(b.id, { expectedVersion: b.version, data: { title: 'Latest deleted' } })
                const before = await graph(storage)
                const pending = storage.commit({
                    conditions: [
                        { kind: 'entryVersion', id: a.id, version: stale ? 0 : a.version },
                        { kind: 'entryVersion', id: b.id, version: b.version },
                    ],
                    updates: [{ id: a.id, patch: { sortOrder: 7 } }],
                    delete: b.id,
                    publicGeneration: true,
                })
                if (stale) {
                    await expect(pending).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
                    expect(await graph(storage)).toEqual(before)
                } else {
                    await pending
                    expect(await storage.readEntry(a.id)).toMatchObject({ sortOrder: 7, version: a.version + 1 })
                    expect(await storage.readEntry(b.id)).toBeUndefined()
                    expect(await storage.revisions(b.id)).toEqual([])
                    expect(await storage.publicGeneration()).toBe(before.generation + 1)
                }
                if (kind !== 'memory')
                    expect(
                        await queryRows(
                            database as DrizzleSiteAdminDatabase,
                            "SELECT key FROM site_admin_meta WHERE key LIKE 'content_commit:%'",
                        ),
                    ).toEqual([])
            },
        )

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
        it('matches native Unicode lowercasing before database count and paging', async () => {
            const { core, storage, tick } = await setup(kind)
            for (const title of [
                'École',
                'ÉCOLE second',
                'ÅNGSTRÖM',
                'МОСКВА',
                'ΣΟΣ',
                'ΟΣΑ',
                'Σ',
                'İstanbul',
                'KELVIN',
                'ǅURO',
                'ẞ',
                '𐐀𐐁',
                '*[É]?',
                'A\u0301Σ',
                '\u0345Σ',
                'AΣ\u0345',
            ]) {
                tick()
                await core.createEntry('posts', { locale: 'en', data: { title } })
            }
            const entries = await storage.entries({ models: ['posts'], locale: 'en' })
            for (const q of [
                'école',
                'Ångström',
                'москва',
                'ΣΟΣ',
                'οσ',
                'ος',
                'σ',
                'ς',
                'İ',
                'i',
                '\u0307',
                'kelvin',
                'ǆuro',
                'ß',
                '𐐨',
                '*[é]?',
                'ecole',
                'A\u0301Σ',
                '\u0345Σ',
                'AΣ\u0345',
            ]) {
                const expected = entries.filter(
                    (entry) =>
                        entry.slug.toLocaleLowerCase().includes(q.toLocaleLowerCase()) ||
                        JSON.stringify(entry.data).toLocaleLowerCase().includes(q.toLocaleLowerCase()),
                )
                const first = await storage.pageEntries({ models: ['posts'], locale: 'en', q }, { limit: 1, offset: 0 })
                const second = await storage.pageEntries(
                    { models: ['posts'], locale: 'en', q },
                    { limit: 1, offset: 1 },
                )
                expect(first.total, q).toBe(expected.length)
                expect(
                    first.items.map(({ id }) => id),
                    q,
                ).toEqual(expected.slice(0, 1).map(({ id }) => id))
                expect(second.total, q).toBe(expected.length)
                expect(
                    second.items.map(({ id }) => id),
                    q,
                ).toEqual(expected.slice(1, 2).map(({ id }) => id))
            }
        })

        it('searches a normal 1000-character Greek title through management HTTP without long SQL work', async () => {
            const { core } = await setup(kind)
            await core.createEntry('posts', { locale: 'en', data: { title: 'ΣΟΣ '.repeat(250) } })
            const started = performance.now()
            const response = await handleManagementRequest(
                core,
                new Request(
                    'https://example.test/manage/entries?locale=en&q=' + encodeURIComponent('σος') + '&limit=1',
                ),
                '/manage',
            )
            expect(response.status).toBe(200)
            const result = await response.json()
            expect(result.total).toBe(1)
            expect(result.items[0].data.title).toBe('ΣΟΣ '.repeat(250))
            expect(performance.now() - started).toBeLessThan(2000)
        })

        if (kind !== 'memory') {
            it('backfills legacy search values in bounded batches without changing data/history or other authorized scopes', async () => {
                const { core, storage, database, tick } = await setup(kind)
                for (let index = 0; index < 65; index++) {
                    tick()
                    await core.createEntry('posts', { locale: 'en', data: { title: `École ${index}` } })
                }
                await core.createEntry('posts', { locale: 'ja', data: { title: 'École Japanese' } })
                await core.createEntry('secrets', { data: { title: 'École private' } })
                const physical = database as DrizzleSiteAdminDatabase
                await runAtomic(physical, [{ sql: "DELETE FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'" }])
                const before = await graph(storage)
                const result = await storage.pageEntries(
                    { models: ['posts'], locale: 'en', q: 'école' },
                    { limit: 1, offset: 64 },
                )
                expect(result.total).toBe(65)
                expect(result.items[0]!.data.title).toBe('École 0')
                expect(await graph(storage)).toEqual(before)
                const indexed = await queryRows(
                    physical,
                    "SELECT key FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'",
                )
                expect(indexed).toHaveLength(130)
                expect((await storage.entries({ models: ['posts'], locale: 'en', q: 'ÉCOLE' })).length).toBe(65)
                expect(
                    await queryRows(physical, "SELECT key FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'"),
                ).toEqual(indexed)
            })

            it('keeps old/new projections separate and updates, restores, prunes and deletes search values atomically', async () => {
                const original = defineSiteAdminConfig({
                    models: { posts: { fields: { title: text(), excerpt: text() } } },
                })
                const current = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
                const database = await backend(kind, original)
                const old = createSiteAdmin({ config: original, database })
                const first = await old.createEntry('posts', { data: { title: 'École', excerpt: 'RetiredSecret' } })
                const active = createSiteAdmin({ config: current, database })
                const storage = database.bind(current)
                const physical = database as DrizzleSiteAdminDatabase
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'RetiredSecret' }, { limit: 1, offset: 0 }))
                        .total,
                ).toBe(0)
                expect(
                    (
                        await database
                            .bind(original)
                            .pageEntries({ models: ['posts'], q: 'RetiredSecret' }, { limit: 1, offset: 0 })
                    ).total,
                ).toBe(1)
                const historical = await old.listRevisions(first.id)
                let entry = await active.updateEntry(first.id, {
                    expectedVersion: first.version,
                    data: { title: 'Changed' },
                })
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'école' }, { limit: 1, offset: 0 })).total,
                ).toBe(0)
                entry = await active.restoreRevision(entry.id, first.revisionId, { expectedVersion: entry.version })
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'école' }, { limit: 1, offset: 0 })).total,
                ).toBe(1)
                expect((await old.listRevisions(first.id)).find(({ id }) => id === first.revisionId)).toEqual(
                    historical[0],
                )
                const indexed = await queryRows(
                    physical,
                    "SELECT key,value FROM site_admin_meta WHERE key LIKE 'content_search:v1:%' ORDER BY key",
                )
                await expect(
                    storage.commit({
                        conditions: [{ kind: 'entryVersion', id: entry.id, version: entry.version - 1 }],
                        revisions: [
                            {
                                id: 'conflict-revision',
                                entryId: entry.id,
                                model: 'posts',
                                slug: '',
                                data: { title: 'No partial cache' },
                                actorId: null,
                                createdAt: '2026-10-09T10:00:00Z',
                                assets: [],
                                relations: [],
                            },
                        ],
                        updates: [{ id: entry.id, patch: { currentRevisionId: 'conflict-revision' } }],
                    }),
                ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
                expect(
                    await queryRows(
                        physical,
                        "SELECT key,value FROM site_admin_meta WHERE key LIKE 'content_search:v1:%' ORDER BY key",
                    ),
                ).toEqual(indexed)
                await active.pruneRevisions(entry.id, 0)
                expect(
                    await queryRows(physical, "SELECT key FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'"),
                ).toHaveLength(2)
                await active.deleteEntry(entry.id, { expectedVersion: entry.version })
                expect(
                    await queryRows(physical, "SELECT key FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'"),
                ).toEqual([])
            })
        }

        if (kind !== 'memory')
            it('finishes the exact cold-search budget and resumes larger legacy sets without returning a partial total', async () => {
                const { core, storage, database } = await setup(kind)
                for (let index = 0; index < 256; index++)
                    await core.createEntry('posts', { data: { title: `École ${index}` } })
                const physical = database as DrizzleSiteAdminDatabase
                await runAtomic(physical, [{ sql: "DELETE FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'" }])
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'école' }, { limit: 1, offset: 255 })).total,
                ).toBe(256)
                await core.createEntry('posts', { data: { title: 'École last' } })
                await runAtomic(physical, [{ sql: "DELETE FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'" }])
                const before = await graph(storage)
                await expect(
                    storage.pageEntries({ models: ['posts'], q: 'école' }, { limit: 1, offset: 256 }),
                ).rejects.toMatchObject({ code: 'SITE_ADMIN_SEARCH_PREPARING', status: 503, searchRemaining: 1 })
                expect(
                    await queryRows(physical, "SELECT key FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'"),
                ).toHaveLength(512)
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'école' }, { limit: 1, offset: 256 })).total,
                ).toBe(257)
                expect(await graph(storage)).toEqual(before)
            })

        if (kind !== 'memory')
            it('preserves a D1-sized canonical value whose lowercase metadata exceeds the native row limit', async () => {
                const definition = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
                const database = await backend(kind, definition),
                    physical = database as DrizzleSiteAdminDatabase
                const controls = batchControls.get(database)
                if (controls) controls.maxValueBytes = 2_000_000
                const core = createSiteAdmin({ config: definition, database }),
                    storage = database.bind(definition)
                // The JSON prefix plus case expansion places the literal marker across a chunk boundary.
                const marker = 'A😀B%_[]C'
                const title = 'İ'.repeat(65_528) + marker + 'İ'.repeat(634_472)
                const entry = await core.createEntry('posts', { slug: 'large-value', data: { title } })
                const before = await graph(storage)
                expect((await core.getEntry(entry.id)).data.title).toBe(title)
                for (const q of [marker, 'i\u0307'.repeat(100) + marker + 'i\u0307'.repeat(75_000)])
                    expect((await storage.pageEntries({ models: ['posts'], q }, { limit: 1, offset: 0 })).total).toBe(1)
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'A😀B%_[]X' }, { limit: 1, offset: 0 })).total,
                ).toBe(0)
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'i\u0307' }, { limit: 1, offset: 0 })).total,
                ).toBe(1)
                expect(
                    (
                        await storage.pageEntries(
                            { models: ['posts'], q: 'i\u0307'.repeat(150_000) },
                            { limit: 1, offset: 0 },
                        )
                    ).total,
                ).toBe(1)
                expect(
                    (
                        await storage.pageEntries(
                            { models: ['posts'], q: 'i\u0307'.repeat(75_000) + 'X' + 'i\u0307'.repeat(75_000) },
                            { limit: 1, offset: 0 },
                        )
                    ).total,
                ).toBe(0)
                const sizes = await queryRows<{ bytes: number }>(
                    physical,
                    "SELECT length(CAST(key AS BLOB))+length(CAST(value AS BLOB)) AS bytes FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'",
                )
                expect(sizes.length).toBeGreaterThan(2)
                expect(sizes.every(({ bytes }) => bytes < 2_000_000)).toBe(true)
                await runAtomic(physical, [{ sql: "DELETE FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'" }])
                expect(
                    (await storage.pageEntries({ models: ['posts'], q: 'i\u0307' }, { limit: 1, offset: 0 })).total,
                ).toBe(1)
                expect((await core.getEntry(entry.id)).data.title).toBe(title)
                expect(await graph(storage)).toEqual(before)
            }, 20_000)

        if (kind === 'd1')
            it('resumes a large cold search through the standard client within each fresh request budget', async () => {
                const definition = defineSiteAdminConfig({
                    authorization: { roles: { reader: { models: { posts: ['readDraft'] } } } },
                    models: { posts: { fields: { title: text() } } },
                })
                const database = await backend(kind, definition),
                    physical = database as DrizzleSiteAdminDatabase
                const original = createSiteAdmin({ config: definition, database })
                for (let index = 0; index < 2_049; index++)
                    await original.createEntry('posts', { slug: `cold-${index}`, data: { title: `École ${index}` } })
                const before = await graph(database.bind(definition))
                await runAtomic(physical, [{ sql: "DELETE FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'" }])
                const controls = batchControls.get(database)!,
                    requests: number[] = [],
                    remaining: number[] = []
                const client = createSiteAdminManagementClient({
                    basePath: '/manage',
                    fetch: async (input, init) => {
                        controls.calls = 0
                        controls.maxCalls = 50
                        controls.trace = []
                        for (let index = 0; index < 10; index++) await physical.query('SELECT 1')
                        const fresh = createSiteAdmin({
                            config: definition,
                            database,
                            authorize: () => ({ id: 'reader', roles: ['reader'] }),
                        })
                        const response = await handleManagementRequest(
                            fresh,
                            new Request(new URL(String(input), 'https://example.test'), init),
                            '/manage',
                        )
                        requests.push(controls.calls!)
                        expect(controls.trace.every((sql) => !/^\s*(?:UPDATE|DELETE)/iu.test(sql))).toBe(true)
                        if (response.status === 503)
                            remaining.push((await response.clone().json()).error.searchRemaining)
                        return response
                    },
                })
                const page = await client.listEntries('posts', { q: 'école', limit: 1, offset: 2_048 })
                expect(page.total).toBe(2_049)
                expect(page.items).toHaveLength(1)
                expect(requests.length).toBeGreaterThan(1)
                expect(requests.every((calls) => calls <= 50)).toBe(true)
                expect(remaining.every((value, index) => index === 0 || value < remaining[index - 1]!)).toBe(true)
                delete controls.maxCalls
                delete controls.trace
                expect(await graph(database.bind(definition))).toEqual(before)
            }, 30_000)

        if (kind === 'd1')
            it('retries when another schema writer installs an unindexed head before the page snapshot', async () => {
                const original = defineSiteAdminConfig({
                    models: { posts: { fields: { title: text(), excerpt: text() } } },
                })
                const current = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
                const database = await backend(kind, original)
                const old = createSiteAdmin({ config: original, database })
                await old.createEntry('posts', { data: { title: 'École initial', excerpt: 'old' } })
                const controls = batchControls.get(database)!
                const writer = createSiteAdmin({ config: original, database: await controls.otherConnection!() })
                let injected = false
                controls.beforeBatch = async (queries) => {
                    if (injected || !queries.some((sql) => sql.includes('AS missing'))) return
                    injected = true
                    await writer.createEntry('posts', { data: { title: 'École concurrent', excerpt: 'old writer' } })
                }
                const result = await database
                    .bind(current)
                    .pageEntries({ models: ['posts'], q: 'école' }, { limit: 1, offset: 1 })
                expect(injected).toBe(true)
                expect(result.total).toBe(2)
                expect(result.items).toHaveLength(1)
                expect(result.items[0]!.data).toEqual({ title: 'École initial' })
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
