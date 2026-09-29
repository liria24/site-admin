import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { boolean, defineSiteAdminConfig, number, object, text } from '../packages/site-admin/src'
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
})
