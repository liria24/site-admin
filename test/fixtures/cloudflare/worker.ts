import { drizzle, type AnyD1Database } from 'drizzle-orm/d1'
import { Files } from 'files-sdk'
import { r2 } from 'files-sdk/r2'
import { drizzleAdapter } from '../../../packages/site-admin/src/adapters/drizzle'
// @ts-ignore Test setup generates this application schema before bundling.
import * as schema from './.data/schema/schema'

import { defineSiteAdminConfig, file, text } from '../../../packages/site-admin/src/index'
import { queryRow, runAtomic } from '../../sqlite-queries'
import { createSiteAdmin } from '../../../packages/site-admin/src/server/index'
import { searchProbe } from './search-probe'

interface Env {
    SITE_ADMIN_DB: AnyD1Database
    ASSETS: Extract<Parameters<typeof r2>[0], { binding: unknown }>['binding']
    DRAFT_ASSETS: Env['ASSETS']
}

const config = defineSiteAdminConfig({
    assets: { storage: 'content' },
    models: { posts: { fields: { attachment: file(), title: text({ required: true }) }, route: true, sortable: true } },
})

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            if (new URL(request.url).pathname === '/health') return new Response('OK')
            if (new URL(request.url).pathname.startsWith('/search-'))
                return await searchProbe(request, env.SITE_ADMIN_DB, schema)
            const database = drizzleAdapter(drizzle(env.SITE_ADMIN_DB), { schema })
            if (new URL(request.url).pathname === '/missing-binding') {
                const missing = drizzleAdapter(drizzle(undefined as unknown as AnyD1Database), { schema })
                await queryRow(missing, 'SELECT 1')
            }
            if (new URL(request.url).pathname === '/rollback') {
                const key = crypto.randomUUID()
                try {
                    await runAtomic(database, [
                        { params: [key, 'one'], sql: 'INSERT INTO site_admin_meta(key, value) VALUES (?, ?)' },
                        { params: [key, 'two'], sql: 'INSERT INTO site_admin_meta(key, value) VALUES (?, ?)' },
                    ])
                } catch {}
                return Response.json({
                    rolledBack: !(await queryRow(database, 'SELECT value FROM site_admin_meta WHERE key = ?', [key])),
                })
            }
            const files = new Files({ adapter: r2({ binding: env.ASSETS }) })
            if (new URL(request.url).pathname === '/alias') {
                const aliased = createSiteAdmin({
                    config: { ...config, assets: { storage: 'content', separateDrafts: true } },
                    database,
                    getFiles: async () => new Files({ adapter: r2({ binding: env.ASSETS }) }),
                })
                try {
                    await aliased.initialize()
                } catch (error) {
                    return Response.json({
                        rejected:
                            error instanceof Error &&
                            'code' in error &&
                            error.code === 'SITE_ADMIN_STORAGE_UNAVAILABLE',
                    })
                }
                return Response.json({ rejected: false })
            }
            if (new URL(request.url).pathname === '/separation') {
                const draftFiles = new Files({ adapter: r2({ binding: env.DRAFT_ASSETS }) })
                const separated = createSiteAdmin({
                    config: {
                        ...config,
                        assets: { storage: 'content', separateDrafts: true, cleanup: { minimumAge: 0 } },
                    },
                    database,
                    getFiles: async (name) => (name === 'draft' ? draftFiles : files),
                })
                const asset = await separated.uploadAsset({
                    body: request.body!,
                    size: Number(request.headers.get('x-upload-size')),
                    filename: 'separated.bin',
                })
                let entry = await separated.createEntry('posts', { data: { title: 'Separated', attachment: asset.id } })
                const privateBefore = await draftFiles.exists(asset.key)
                const publicBefore = (await files.list({ prefix: `site-admin/public/${asset.id}/` })).items.length
                entry = await separated.publishEntry(entry.id, { expectedVersion: entry.version })
                const publicAsset = await separated.downloadAsset(asset.id)
                const copiedBytes = (await publicAsset.file.arrayBuffer()).byteLength
                entry = await separated.unpublishEntry(entry.id, { expectedVersion: entry.version })
                const cleared = (await files.list({ prefix: `site-admin/public/${asset.id}/` })).items.length === 0
                const retained = await draftFiles.exists(asset.key)
                await separated.deleteEntry(entry.id, { expectedVersion: entry.version })
                const deleted = (await separated.runAssetGC()).deleted.includes(asset.id)
                return Response.json({ privateBefore, publicBefore, copiedBytes, cleared, retained, deleted })
            }
            const admin = createSiteAdmin({ config, database, getFiles: async () => files })
            if (new URL(request.url).pathname === '/upload') {
                const asset = await admin.uploadAsset({
                    body: request.body!,
                    size: Number(request.headers.get('x-upload-size')),
                    filename: 'stream.bin',
                })
                const stored = await files.download(asset.key)
                const size = (await stored.arrayBuffer()).byteLength
                await admin.deleteAsset(asset.id)
                return Response.json({ asset, size })
            }
            if (new URL(request.url).pathname === '/reorder') {
                const entries = await Promise.all(
                    ['sort-a', 'sort-b'].map((title) => admin.createEntry('posts', { data: { title } })),
                )
                const published = await Promise.all(
                    entries.map((entry) => admin.publishEntry(entry.id, { expectedVersion: entry.version })),
                )
                const items = published.map((entry, sortOrder) => ({
                    id: entry.id,
                    sortOrder,
                    expectedVersion: entry.version,
                }))
                const before = await admin.publicGeneration()
                let conflict = false
                try {
                    await admin.setSortOrders('posts', [items[0]!, { ...items[1]!, expectedVersion: 999 }])
                } catch {
                    conflict = true
                }
                const unchanged =
                    (await admin.getEntry(items[0]!.id)).version === items[0]!.expectedVersion &&
                    (await admin.publicGeneration()) === before
                const sorted = await admin.setSortOrders('posts', items)
                return Response.json({
                    conflict,
                    unchanged,
                    sorted: sorted.map((entry) => entry.sortOrder),
                    generation: (await admin.publicGeneration()) - before,
                })
            }
            const draft = await admin.createEntry('posts', { data: { title: 'D1' } })
            const published = await admin.publishEntry(draft.id, { expectedVersion: draft.version })
            let conflict = false
            try {
                await admin.updateEntry(draft.id, { data: { title: 'stale' }, expectedVersion: draft.version })
            } catch {
                conflict = true
            }
            return Response.json({ conflict, entries: await admin.listPublicEntries('posts'), published })
        } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : 'failed' }, { status: 500 })
        }
    },
}
