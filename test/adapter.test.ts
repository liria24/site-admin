import { expect, it } from 'vitest'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { assertAtomicResults, type SiteAdminDatabase } from '../packages/site-admin/src/adapter'
import { createSiteAdmin } from '../packages/site-admin/src/server'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { migrateTestDatabase } from './migrate'

it('runs Core through a non-Drizzle adapter, including rollback and optimistic publication', async () => {
    const config = defineSiteAdminConfig({
        models: { posts: { fields: { title: text({ required: true }) }, route: '/posts/:slug' } },
    })
    const db = createDatabase(nodeSqlite({ name: ':memory:' }))
    try {
        // Only offline migration generation uses Drizzle. This runtime adapter uses Node SQLite directly.
        await migrateTestDatabase(db, config)
        const client = (await db.getInstance()) as DatabaseSync
        const adapter: SiteAdminDatabase = {
            dialect: 'sqlite',
            query: async (sql, params = []) => client.prepare(sql).all(...(params as SQLInputValue[])),
            atomic: async (statements) => {
                client.exec('BEGIN IMMEDIATE')
                try {
                    const results = statements.map(({ sql, params = [], query }) =>
                        query
                            ? { rows: client.prepare(sql).all(...(params as SQLInputValue[])) }
                            : {
                                  rows: [],
                                  changes: Number(client.prepare(sql).run(...(params as SQLInputValue[])).changes),
                              },
                    )
                    assertAtomicResults(statements, results)
                    client.exec('COMMIT')
                    return results
                } catch (error) {
                    client.exec('ROLLBACK')
                    throw error
                }
            },
            bind: (definition) => {
                expect(definition).toBe(config)
                return {
                    assertSchema: async () => {
                        client.prepare('SELECT field_title FROM site_admin_content_posts LIMIT 0').all()
                    },
                    revisionSource: `(SELECT r.*, json_object('title', d.field_title) AS data FROM site_admin_revisions r JOIN site_admin_content_posts d ON d.revision_id=r.id)`,
                    insertRevisionData: (model, revisionId, data) => {
                        expect(model).toBe('posts')
                        return {
                            sql: 'INSERT INTO site_admin_content_posts(revision_id, field_title) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM site_admin_revisions WHERE id = ?)',
                            params: [revisionId, String(data.title), revisionId],
                        }
                    },
                }
            },
        }
        const core = createSiteAdmin({ config, database: adapter })
        let entry = await core.createEntry('posts', { slug: 'test', data: { title: 'draft' } })
        entry = await core.publishEntry(entry.id, { expectedVersion: entry.version })
        expect((await core.getPublicEntry('posts', 'test'))?.data.title).toBe('draft')
        await expect(
            core.updateEntry(entry.id, { expectedVersion: 0, data: { title: 'stale' } }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        expect((await core.getEntry(entry.id)).data.title).toBe('draft')
        await expect(
            adapter.atomic([
                { sql: "INSERT INTO site_admin_meta VALUES ('rollback-test', '1')" },
                { sql: "SELECT id FROM site_admin_entries WHERE id = 'missing'", query: true, expectRow: true },
            ]),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        expect(await adapter.query("SELECT * FROM site_admin_meta WHERE key = 'rollback-test'")).toEqual([])
    } finally {
        await db.dispose()
    }
})
