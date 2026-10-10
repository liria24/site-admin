import { drizzle, type AnyD1Database } from 'drizzle-orm/d1'
import { drizzleAdapter } from '../../../packages/site-admin/src/adapters/drizzle'
import { defineSiteAdminConfig, file, text } from '../../../packages/site-admin/src/index'
import { createSiteAdmin, handleManagementRequest } from '../../../packages/site-admin/src/server/index'

const config = defineSiteAdminConfig({
    models: { posts: { fields: { attachment: file(), title: text({ required: true }) }, route: true, sortable: true } },
})

/** Synthetic local-worker probes; the production package has no seeding or query-budget wrapper. */
export async function searchProbe(request: Request, binding: AnyD1Database, schema: Record<string, unknown>) {
    const path = new URL(request.url).pathname
    const database = drizzleAdapter(drizzle(binding), { schema })
    if (path === '/search-long-query') {
        const core = createSiteAdmin({ config, database, authorize: () => ({ id: 'probe', roles: ['admin'] }) })
        const entry = await core.createEntry('posts', { data: { title: 'a'.repeat(512) } })
        const storage = database.bind(config)
        const counts = [
            (await storage.pageEntries({ models: ['posts'], q: 'a'.repeat(512) }, { limit: 1, offset: 0 })).total,
        ]
        const rejected: string[] = []
        for (const q of ['a'.repeat(513), '😀'.repeat(513), 'İ'.repeat(257)]) {
            try {
                await storage.pageEntries({ q }, { limit: 1, offset: 0 })
            } catch (error) {
                rejected.push((error as { code: string }).code)
            }
        }
        const response = await handleManagementRequest(
            core,
            new Request('http://localhost/manage/entries?q=' + 'a'.repeat(513)),
            '/manage',
        )
        await core.deleteEntry(entry.id, { expectedVersion: entry.version })
        return Response.json({ counts, rejected, status: response.status })
    }
    if (path === '/search-large') {
        const core = createSiteAdmin({ config, database })
        const marker = 'A😀B%_[]C'
        const title = 'İ'.repeat(65_528) + marker + 'İ'.repeat(634_472)
        const entry = await core.createEntry('posts', { slug: 'large-local-probe', data: { title } })
        const storage = database.bind(config)
        const before = JSON.stringify(await storage.revisions(entry.id))
        const counts: number[] = []
        const started = performance.now()
        for (const q of [marker, 'i\u0307'.repeat(100) + marker + 'i\u0307'.repeat(100), 'A😀B%_[]X'])
            counts.push((await storage.pageEntries({ models: ['posts'], q }, { limit: 1, offset: 0 })).total)
        await database.atomic([{ sql: "DELETE FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'" }])
        counts.push((await storage.pageEntries({ models: ['posts'], q: marker }, { limit: 1, offset: 0 })).total)
        const elapsed = performance.now() - started
        const unchanged =
            before === JSON.stringify(await storage.revisions(entry.id)) &&
            (await core.getEntry(entry.id)).data.title === title
        const sizes = await database.query(
            "SELECT length(CAST(key AS BLOB))+length(CAST(value AS BLOB)) AS bytes FROM site_admin_meta WHERE key LIKE 'content_search:v1:%'",
        )
        await core.deleteEntry(entry.id, { expectedVersion: entry.version })
        return Response.json({ counts, unchanged, sizes, elapsed })
    }
    if (path === '/search-cold/seed') {
        const candidates = JSON.stringify(
            Array.from({ length: 257 }, (_, index) => ({ id: `cold-probe-${index}`, title: `École ${index}` })),
        )
        await database.atomic([
            {
                sql: "INSERT INTO site_admin_entries(id,model,translation_group,version,created_at,updated_at) SELECT json_extract(value,'$.id'),'posts',json_extract(value,'$.id'),1,'2026-10-09','2026-10-09' FROM json_each(?)",
                params: [candidates],
            },
            {
                sql: "INSERT INTO site_admin_revisions(id,entry_id,slug,created_at) SELECT json_extract(value,'$.id')||'-r',json_extract(value,'$.id'),json_extract(value,'$.id'),'2026-10-09' FROM json_each(?)",
                params: [candidates],
            },
            {
                sql: "INSERT INTO site_admin_content_posts(revision_id,field_title) SELECT json_extract(value,'$.id')||'-r',json_extract(value,'$.title') FROM json_each(?)",
                params: [candidates],
            },
            {
                sql: "UPDATE site_admin_entries SET current_revision_id=id||'-r' WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
                params: [candidates],
            },
        ])
        return Response.json({ seeded: 257 })
    }
    if (path === '/search-cold/state') {
        const heads = await database.query("SELECT * FROM site_admin_entries WHERE id LIKE 'cold-probe-%' ORDER BY id")
        const revisions = await database.query(
            "SELECT r.*,c.* FROM site_admin_revisions r JOIN site_admin_content_posts c ON c.revision_id=r.id WHERE r.entry_id LIKE 'cold-probe-%' ORDER BY r.id",
        )
        return Response.json({ heads, revisions })
    }
    let calls = 0
    const count = (amount = 1) => {
        calls += amount
        if (calls > 50) throw new Error('Fresh D1 request exceeded 50 native statements.')
    }
    const watch = (statement: ReturnType<typeof binding.prepare>): ReturnType<typeof binding.prepare> =>
        new Proxy(statement, {
            get(target, key) {
                if (key === 'bind') return (...params: Parameters<typeof target.bind>) => watch(target.bind(...params))
                if (key === 'all')
                    return () => {
                        count()
                        return target.all()
                    }
                const value = Reflect.get(target, key)
                return typeof value === 'function' ? value.bind(target) : value
            },
        })
    const limited = new Proxy(binding, {
        get(target, key) {
            if (key === 'prepare') return (sql: string) => watch(target.prepare(sql))
            if (key === 'batch')
                return (statements: Parameters<typeof target.batch>[0]) => {
                    count(statements.length)
                    return target.batch(statements)
                }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
    const freshDatabase = drizzleAdapter(drizzle(limited), { schema })
    for (let index = 0; index < 10; index++) await freshDatabase.query('SELECT 1')
    const fresh = createSiteAdmin({
        config,
        database: freshDatabase,
        authorize: () => ({ id: 'local-reader', roles: ['admin'] }),
    })
    const response = await handleManagementRequest(fresh, request, '/search-cold/manage')
    response.headers.set('x-native-query-calls', String(calls))
    return response
}
