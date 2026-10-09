import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import {
    array,
    boolean,
    defineSiteAdminConfig,
    markdown,
    number,
    object,
    select,
    text,
} from '../packages/site-admin/src'
import { createSiteAdmin } from '../packages/site-admin/src/server'
import { generateSiteAdminSchema, generateCombinedSchema } from '../packages/site-admin/src/generate'
import { createJiti } from 'jiti'
import { getTableName } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { migrateTestDatabase, testAdapter } from './migrate'

const databases: Database[] = []
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.dispose())))
const database = () => {
    const value = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(value)
    return value
}
const authConfig = () => ({ account: { additionalFields: { issuer: { type: 'string' as const } } } })

describe('application-owned Drizzle migrations', () => {
    it('generates auth plugins and content in one deterministic, importable schema without a database', async () => {
        const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
        const source = await generateCombinedSchema(config, authConfig, { usePlural: true })
        expect(source).toBe(await generateCombinedSchema(config, authConfig, { usePlural: true }))
        const directory = await mkdtemp(resolve('test/.schema-'))
        try {
            const file = resolve(directory, 'schema.ts')
            await writeFile(file, source)
            const schema = await createJiti(import.meta.url, { fsCache: false }).import<{
                users: SQLiteTable & { role: unknown }
                entries: SQLiteTable
                authRelations: unknown
            }>(file)
            expect(getTableName(schema.users)).toBe('users')
            expect(schema.users.role).toBeDefined()
            expect(getTableName(schema.entries)).toBe('site_admin_entries')
            expect(schema.authRelations).toBeDefined()
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
        await expect(
            generateCombinedSchema(config, { user: { modelName: 'entrie' } }, { usePlural: true }),
        ).rejects.toThrow('Duplicate schema export')
        await expect(
            generateCombinedSchema(config, { user: { modelName: 'site_admin_entrie' } }, { usePlural: true }),
        ).rejects.toThrow('Duplicate schema table')
    })
    it('accepts numeric cleanup ages and rejects ambiguous or invalid durations', async () => {
        const db = await testAdapter(database(), { models: {} })
        for (const minimumAge of [0, 0.5, 86400])
            expect(() =>
                createSiteAdmin({
                    database: db,
                    config: { assets: { storage: 'content', cleanup: { minimumAge } }, models: {} },
                }),
            ).not.toThrow()
        for (const minimumAge of [-1, NaN, Infinity, '24h'])
            expect(() =>
                createSiteAdmin({
                    database: db,
                    config: {
                        assets: { storage: 'content', cleanup: { minimumAge: minimumAge as number } },
                        models: {},
                    },
                }),
            ).toThrow('seconds')
    })
    it('requires explicit DDL, stores typed columns, and omits absent optional fields', async () => {
        const db = database()
        const config = defineSiteAdminConfig({
            models: {
                posts: {
                    fields: {
                        title: text({ required: true }),
                        optional: text(),
                        count: number({ integer: true }),
                        rating: number(),
                        enabled: boolean(),
                        nested: object({ value: text() }),
                    },
                },
            },
        })
        await expect(
            createSiteAdmin({ config, database: await testAdapter(db, config) }).initialize(),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_MIGRATION_REQUIRED',
        })
        expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
        await migrateTestDatabase(db, config)
        const admin = createSiteAdmin({ config, database: await testAdapter(db, config) })
        const entry = await admin.createEntry('posts', {
            data: { title: 'Typed', count: 3, enabled: false, nested: { value: 'nested' } },
        })
        expect(entry.data).toEqual({ title: 'Typed', count: 3, enabled: false, nested: { value: 'nested' } })
        expect(
            await db
                .prepare('SELECT field_title, field_count, field_enabled, field_nested FROM site_admin_content_posts')
                .get(),
        ).toEqual({ field_title: 'Typed', field_count: 3, field_enabled: 0, field_nested: '{"value":"nested"}' })
        const columns = (await db.prepare('PRAGMA table_info(site_admin_revisions)').all()) as Array<{ name: string }>
        expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(['data', 'schema_version']))
        const changed = defineSiteAdminConfig({
            models: { posts: { fields: { ...config.models.posts.fields, added: text() } } },
        })
        const oldSchema = await testAdapter(db, config)
        expect(() => createSiteAdmin({ config: changed, database: oldSchema })).toThrow('Regenerate')
        await expect(
            createSiteAdmin({ config: changed, database: await testAdapter(db, changed) }).initialize(),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_MIGRATION_REQUIRED',
        })
    })

    it('generates deterministic application schema and rejects unsafe identifiers', () => {
        const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text({ required: true }) } } } })
        const generated = generateSiteAdminSchema(config)
        expect(generated).toBe(generateSiteAdminSchema(config))
        expect(generated).toContain('text("field_title").notNull()')
        expect(generated).not.toContain('schemaVersion')
        expect(generated).not.toContain('@liria24/site-admin/schema')
        expect(generated).toContain("from 'drizzle-orm/sqlite-core'")
        expect(() => generateSiteAdminSchema({ models: { posts: { fields: { revisionId: text() } } } })).toThrow()
    })

    it('keeps removed optional columns and historical values with old or regenerated application mappings', async () => {
        const db = database()
        const original = defineSiteAdminConfig({
            models: { posts: { fields: { title: text({ required: true }), excerpt: text() } } },
        })
        const current = defineSiteAdminConfig({ models: { posts: { fields: { title: text({ required: true }) } } } })
        await migrateTestDatabase(db, original)
        const oldMapping = await testAdapter(db, original)
        const previous = await createSiteAdmin({ config: original, database: oldMapping }).createEntry('posts', {
            data: { title: 'before', excerpt: 'retained history' },
        })
        for (const adapter of [oldMapping, await testAdapter(db, current)]) {
            const admin = createSiteAdmin({ config: current, database: adapter })
            await admin.initialize()
            const entry = await admin.getEntry(previous.id)
            expect(entry.data).toEqual({ title: 'before' })
            const next = await admin.createEntry('posts', { data: { title: 'after' } })
            const edited = await admin.updateEntry(next.id, {
                expectedVersion: next.version,
                data: { title: 'edited' },
            })
            await admin.publishEntry(edited.id, { expectedVersion: edited.version })
            expect((await admin.getPublicEntry('posts', edited.id))?.data).toEqual({ title: 'edited' })
            expect(
                await db
                    .prepare('SELECT field_excerpt FROM site_admin_content_posts WHERE revision_id = ?')
                    .get(previous.revisionId),
            ).toEqual({ field_excerpt: 'retained history' })
        }
        const columns = (await db.prepare('PRAGMA table_info(site_admin_content_posts)').all()) as Array<{
            name: string
        }>
        expect(columns.map((column) => column.name)).toContain('field_excerpt')
    })
    it('projects retired nested fields on public reads without rewriting history or loosening writes', async () => {
        const db = database()
        const original = defineSiteAdminConfig({
            models: {
                posts: {
                    route: '/posts/:slug',
                    fields: {
                        title: text({ required: true }),
                        body: markdown(),
                        excerpt: text(),
                        publication: object({ slug: select(['auto', 'manual']), excerpt: select(['auto', 'manual']) }),
                        sections: array(object({ heading: text(), retired: text() })),
                    },
                },
            },
        })
        const current = defineSiteAdminConfig({
            models: {
                posts: {
                    route: '/posts/:slug',
                    displayFields: { description: 'body' },
                    fields: {
                        title: text({ required: true }),
                        body: markdown(),
                        publication: object({ slug: select(['auto', 'manual']) }),
                        sections: array(object({ heading: text() })),
                    },
                },
            },
        })
        await migrateTestDatabase(db, original)
        const oldMapping = await testAdapter(db, original)
        const legacy = createSiteAdmin({ config: original, database: oldMapping })
        let entry = await legacy.createEntry('posts', {
            slug: 'historical',
            data: {
                title: 'Stored',
                body: 'Introduction\n\n<!-- more -->\n\nFull historical body',
                excerpt: 'Retired description',
                publication: { slug: 'manual', excerpt: 'auto' },
                sections: [{ heading: 'Active', retired: 'Historical secret' }],
            },
        })
        entry = await legacy.publishEntry(entry.id, { expectedVersion: entry.version })
        const history = () =>
            db.prepare('SELECT * FROM site_admin_content_posts WHERE revision_id=?').get(entry.revisionId)
        const before = await history()
        for (const mapping of [oldMapping, await testAdapter(db, current)]) {
            const admin = createSiteAdmin({ config: current, database: mapping })
            const publicEntries = await admin.listPublicEntries('posts')
            expect(publicEntries).toHaveLength(1)
            expect(publicEntries[0]?.data.publication).toEqual({ slug: 'manual' })
            expect(publicEntries[0]?.data.sections).toEqual([{ heading: 'Active' }])
            const files = await (await admin.content('posts')).list()
            expect(files).toHaveLength(1)
            expect(files[0]?.data).toMatchObject({ _siteAdmin: { seo: { description: 'Introduction' } } })
            expect(JSON.stringify(files)).not.toMatch(/Retired description|Historical secret|"excerpt"/u)
            await expect(
                admin.createEntry('posts', {
                    data: {
                        title: 'New',
                        publication: { slug: 'manual', excerpt: 'auto' },
                    },
                }),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
            const latest = await admin.getEntry(entry.id)
            await admin.updateEntry(entry.id, {
                expectedVersion: latest.version,
                data: {
                    title: 'Edited',
                    body: 'New body',
                    publication: { slug: 'manual' },
                    sections: [{ heading: 'New' }],
                },
            })
            expect((await admin.getEntry(entry.id)).publishedRevisionId).toBe(entry.publishedRevisionId)
            expect(await history()).toEqual(before)
        }
        await db
            .prepare('UPDATE site_admin_content_posts SET field_publication=? WHERE revision_id=?')
            .bind(JSON.stringify({ slug: 42, excerpt: 'auto' }), entry.revisionId)
            .run()
        expect(await createSiteAdmin({ config: current, database: oldMapping }).listPublicEntries('posts')).toEqual([])
    })

    it('permits retained defaulted columns but rejects required extras that prevent active-column inserts', async () => {
        const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
        const db = database()
        await migrateTestDatabase(db, config)
        await db.exec("ALTER TABLE site_admin_content_posts ADD COLUMN legacy TEXT NOT NULL DEFAULT 'preserved'")
        const admin = createSiteAdmin({ config, database: await testAdapter(db, config) })
        await admin.createEntry('posts', { data: { title: 'new' } })
        await admin.createEntry('posts', { data: { title: 'second' } })
        expect(await db.prepare('SELECT legacy FROM site_admin_content_posts').get()).toEqual({ legacy: 'preserved' })

        const blocked = database()
        await migrateTestDatabase(blocked, {
            models: { posts: { fields: { title: text(), excerpt: text({ required: true }) } } },
        })
        await expect(
            createSiteAdmin({ config, database: await testAdapter(blocked, config) }).initialize(),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_MIGRATION_REQUIRED' })

        const constrained = database()
        await migrateTestDatabase(constrained, { models: { posts: { fields: { title: text({ required: true }) } } } })
        await expect(
            createSiteAdmin({ config, database: await testAdapter(constrained, config) }).initialize(),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_MIGRATION_REQUIRED' })
    })

    it.each(['NULL', '(NULL)', '((null))', '( ( NULL ) )'])(
        'rejects retained NOT NULL DEFAULT %s before any writes',
        async (value) => {
            const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
            const db = database()
            await migrateTestDatabase(db, config)
            await db.exec(`ALTER TABLE site_admin_content_posts ADD COLUMN legacy TEXT NOT NULL DEFAULT ${value}`)
            const admin = createSiteAdmin({ config, database: await testAdapter(db, config) })
            await expect(admin.initialize()).rejects.toMatchObject({ code: 'SITE_ADMIN_MIGRATION_REQUIRED' })
            expect(await db.prepare('SELECT COUNT(*) AS count FROM site_admin_entries').get()).toEqual({ count: 0 })
        },
    )

    it.each(["'constant'", '42', 'TRUE'])(
        'rejects retained UNIQUE constant default %s while retaining history',
        async (value) => {
            const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
            const db = database()
            await migrateTestDatabase(db, config)
            await db.exec(`ALTER TABLE site_admin_content_posts ADD COLUMN legacy TEXT DEFAULT ${value}`)
            await db.exec('CREATE UNIQUE INDEX retained_unique ON site_admin_content_posts(legacy)')
            await expect(
                createSiteAdmin({ config, database: await testAdapter(db, config) }).initialize(),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_MIGRATION_REQUIRED' })
            expect(await db.prepare('SELECT COUNT(*) AS count FROM site_admin_entries').get()).toEqual({ count: 0 })
        },
    )

    it('permits retained nullable UNIQUE columns and a constant key paired with revision ID', async () => {
        const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
        const db = database()
        await migrateTestDatabase(db, config)
        await db.exec("ALTER TABLE site_admin_content_posts ADD COLUMN legacy TEXT DEFAULT 'NULL'")
        await db.exec('ALTER TABLE site_admin_content_posts ADD COLUMN optional TEXT DEFAULT (NULL)')
        await db.exec(
            'CREATE UNIQUE INDEX retained_nullable ON site_admin_content_posts(optional) WHERE optional IS NOT NULL',
        )
        await db.exec('CREATE UNIQUE INDEX retained_revision ON site_admin_content_posts(legacy,revision_id)')
        const admin = createSiteAdmin({ config, database: await testAdapter(db, config) })
        await admin.createEntry('posts', { data: { title: 'one' } })
        await admin.createEntry('posts', { data: { title: 'two' } })
        expect(await db.prepare('SELECT legacy,optional FROM site_admin_content_posts').all()).toEqual([
            { legacy: 'NULL', optional: null },
            { legacy: 'NULL', optional: null },
        ])
    })

    it.each([false, true])('rejects retained partial UNIQUE columns with old mapping: %s', async (oldMapping) => {
        const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
        const previous = defineSiteAdminConfig({ models: { posts: { fields: { title: text(), excerpt: text() } } } })
        const db = database()
        await migrateTestDatabase(db, config)
        await db.exec("ALTER TABLE site_admin_content_posts ADD COLUMN field_excerpt TEXT DEFAULT 'same'")
        await db.exec(
            'CREATE UNIQUE INDEX retained_partial ON site_admin_content_posts(field_excerpt) WHERE field_excerpt IS NOT NULL',
        )
        const admin = createSiteAdmin({ config, database: await testAdapter(db, oldMapping ? previous : config) })
        await expect(admin.initialize()).rejects.toMatchObject({ code: 'SITE_ADMIN_MIGRATION_REQUIRED' })
        expect(await db.prepare('SELECT COUNT(*) AS count FROM site_admin_entries').get()).toEqual({ count: 0 })
    })
})
