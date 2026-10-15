import { afterEach, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.dispose()))
})
const setup = async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    await database.exec('PRAGMA foreign_keys = ON')
    const admin = await createMigratedTestAdmin({
        database,
        config: defineSiteAdminConfig({
            models: {
                products: { fields: { title: text(), code: text() }, route: '/products/:code' },
                announcements: { fields: { title: text() }, route: true, revisions: false },
                links: {
                    fields: { title: text() },
                    route: true,
                    publishing: false,
                    scheduling: false,
                    revisions: false,
                },
            },
        }),
    })
    return { admin, database }
}
it('uses declared fields for routes, keeps aliases and never creates a slug', async () => {
    const { admin } = await setup()
    let entry = await admin.createEntry('products', { data: { title: 'Product', code: '' } })
    expect(entry).not.toHaveProperty('slug')
    await expect(admin.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
        code: 'SITE_ADMIN_INVALID_INPUT',
    })
    entry = await admin.publishEntry(entry.id, {
        expectedVersion: entry.version,
        draft: { data: { title: 'Product', code: 'A B' } },
    })
    expect(await admin.resolvePath('/products/A%20B')).toMatchObject({ kind: 'page', entry: { id: entry.id } })
    entry = await admin.publishEntry(entry.id, {
        expectedVersion: entry.version,
        draft: { data: { title: 'Product', code: 'C' } },
    })
    expect(await admin.resolvePath('/products/A%20B')).toMatchObject({ kind: 'redirect', target: '/products/C' })
    expect(
        (await admin.pageEntries({ models: ['products'], q: 'Product' }, { limit: 20, offset: 0 })).items,
    ).toHaveLength(1)
})
it('keeps only live revisions and their references atomically when history is disabled', async () => {
    const { admin, database } = await setup()
    let entry = await admin.createEntry('links', { data: { title: 'First' } })
    for (const title of ['Second', 'Third'])
        entry = await admin.updateEntry(entry.id, { data: { title }, expectedVersion: entry.version })
    expect(entry.publishedRevisionId).toBe(entry.currentRevisionId)
    expect(await database.prepare('SELECT id FROM site_admin_revisions WHERE entry_id = ?').all(entry.id)).toHaveLength(
        1,
    )
    expect(await admin.getPublicEntry('links', entry.id)).toMatchObject({ data: { title: 'Third' } })
    await expect(admin.listRevisions(entry.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
    await expect(
        admin.schedulePublish(entry.id, { expectedVersion: entry.version, at: '2099-01-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
    expect(await database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('retains separate live pointers without history and prunes cancelled schedules and replaced publications', async () => {
    const { admin, database } = await setup()
    let entry = await admin.createEntry('announcements', { data: { title: 'Published' } })
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    const published = entry.publishedRevisionId
    entry = await admin.updateEntry(entry.id, { data: { title: 'Scheduled' }, expectedVersion: entry.version })
    entry = await admin.schedulePublish(entry.id, { expectedVersion: entry.version, at: '2099-01-01T00:00:00Z' })
    const scheduled = entry.scheduledRevisionId
    entry = await admin.updateEntry(entry.id, { data: { title: 'Current' }, expectedVersion: entry.version })
    const ids = async () =>
        (await database.prepare('SELECT id FROM site_admin_revisions WHERE entry_id = ?').all(entry.id)).map(
            (row) => (row as { id: string }).id,
        )
    expect(await ids()).toHaveLength(3)
    expect(await ids()).toEqual(expect.arrayContaining([published, scheduled, entry.currentRevisionId]))
    expect((await admin.getPublicEntry('announcements', entry.id))?.data.title).toBe('Published')
    entry = await admin.cancelScheduledPublish(entry.id, { expectedVersion: entry.version })
    expect(await ids()).not.toContain(scheduled)
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    expect(await ids()).toEqual([entry.currentRevisionId])
    expect(await database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
