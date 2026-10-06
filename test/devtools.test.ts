import { expect, it } from 'vitest'
import type { RequestEvent } from 'nuxt/server'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import snapshot from '../packages/site-admin/src/runtime/devtools-snapshot'
import { configureSiteAdminRuntime } from '../packages/site-admin/src/nuxt/server'
import { createSiteAdmin } from '../packages/site-admin/src/server'
import { createMigratedTestAdmin, testAdapter } from './migrate'

it('protects runtime diagnostics and never returns content bodies or field defaults', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    try {
        const siteAdmin = await createMigratedTestAdmin({
            database,
            config: defineSiteAdminConfig({
                models: { posts: { fields: { title: text({ default: 'SECRET_DEFAULT' }) } } },
            }),
            authorize: (request) => {
                const role = request.headers.get('authorization')
                return role ? { id: 'test', roles: [role] } : null
            },
        })
        await siteAdmin.createEntry('posts', { data: { title: 'SECRET_CONTENT_BODY' } })
        configureSiteAdminRuntime({
            getSiteAdmin: () => siteAdmin,
            publicBase: '/api/content',
            managementBase: '/api/site-admin',
            development: { connector: 'sqlite', devDatabase: true },
        })
        const fetch = (req: Request) =>
            snapshot({
                req,
                url: new URL(req.url),
                res: { headers: new Headers() },
                context: {},
            } satisfies RequestEvent)
        expect((await fetch(new Request('http://localhost/snapshot'))).status).toBe(401)
        expect(
            (await fetch(new Request('http://localhost/snapshot', { headers: { authorization: 'user' } }))).status,
        ).toBe(403)
        const response = await fetch(new Request('http://localhost/snapshot', { headers: { authorization: 'admin' } }))
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        const source = await response.text()
        expect(source).not.toContain('SECRET_')
        const result = JSON.parse(source)
        expect(result.database).toMatchObject({ connector: 'sqlite', schemaReady: true, devDatabase: true })
        expect(result.revisions).toHaveLength(1)
        expect(result.models.posts.fields.title).toEqual({ kind: 'text', required: false })
        await database.exec('DROP TABLE site_admin_content_posts')
        configureSiteAdminRuntime({
            publicBase: '/api/content',
            managementBase: '/api/site-admin',
            getSiteAdmin: async () =>
                createSiteAdmin({
                    database: await testAdapter(database, siteAdmin.config),
                    config: siteAdmin.config,
                    authorize: () => ({ id: 'admin', roles: ['admin'] }),
                }),
        })
        const missing = await fetch(new Request('http://localhost/snapshot'))
        expect(missing.status).toBe(200)
        expect(await missing.json()).toMatchObject({
            database: { schemaReady: false },
            diagnostics: [{ code: 'SITE_ADMIN_MIGRATION_REQUIRED' }],
        })
    } finally {
        await database.dispose()
    }
})
