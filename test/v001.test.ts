import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { Files } from 'files-sdk'
import { memory } from 'files-sdk/memory'
import { fs } from 'files-sdk/fs'
import {
    defineSiteAdminAuthorization,
    defineSiteAdminConfig,
    file,
    markdown,
    relation,
    text,
} from '../packages/site-admin/src'
import { managementAssetUrl } from '../packages/site-admin/src/client'
import { createSiteAdmin, handleManagementRequest, handlePublicRequest } from '../packages/site-admin/src/server'
import { createMigratedTestAdmin, testAdapter } from './migrate'

const databases: Database[] = []
const database = () => {
    const value = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(value)
    return value
}
afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(databases.splice(0).map((db) => db.dispose()))
})

it('returns only mutation receipts without readDraft, including sort, older publication, and every sibling action', async () => {
    const config = defineSiteAdminConfig({
        authorization: defineSiteAdminAuthorization({
            operator: { models: { posts: ['create', 'update', 'sort', 'publish', 'schedule', 'restore'] } },
        }),
        models: { posts: { fields: { title: text() }, sortable: true } },
    })
    let roles = ['operator']
    const admin = await createMigratedTestAdmin({
        config,
        database: database(),
        authorize: () => ({ id: 'operator', roles }),
    })
    let entry = await admin.createEntry('posts', { slug: 'secret-slug', data: { title: 'secret draft' } })
    const older = entry.revisionId
    entry = await admin.updateEntry(entry.id, {
        expectedVersion: entry.version,
        slug: 'new-secret-slug',
        data: { title: 'new secret' },
    })
    const mutate = async (path: string, body: object, method = 'POST') => {
        const response = await handleManagementRequest(
            admin,
            new Request(`http://localhost/api/site-admin/${path}`, {
                method,
                body: JSON.stringify(body),
                headers: { 'content-type': 'application/json' },
            }),
        )
        expect(response.ok).toBe(true)
        const value = await response.json()
        for (const receipt of Array.isArray(value) ? value : [value])
            expect(Object.keys(receipt).sort()).toEqual(['id', 'model', 'sortOrder', 'version'])
        expect(JSON.stringify(value)).not.toContain('secret')
        entry = await admin.getEntry(entry.id)
        return value
    }
    await mutate(`entries/${entry.id}/sort`, { expectedVersion: entry.version, sortOrder: 0 }, 'PATCH')
    await mutate('entries/posts/reorder', { items: [{ id: entry.id, expectedVersion: entry.version, sortOrder: 1 }] })
    await mutate(`entries/${entry.id}/publish`, { expectedVersion: entry.version, revisionId: older })
    expect((await admin.getPublicEntry('posts', entry.id))?.data.title).toBe('secret draft')
    expect(entry.data.title).toBe('new secret')
    await mutate(`entries/${entry.id}/schedule`, { expectedVersion: entry.version, at: '2099-01-01T00:00:00Z' })
    await mutate(`entries/${entry.id}/cancel-schedule`, { expectedVersion: entry.version })
    await mutate(`entries/${entry.id}/revisions/${older}/restore`, { expectedVersion: entry.version })
    await mutate(`entries/${entry.id}`, { expectedVersion: entry.version, data: { title: 'another secret' } }, 'PATCH')
    await mutate(`entries/${entry.id}/unpublish`, { expectedVersion: entry.version })
    await mutate('entries/posts', { data: { title: 'created secret' }, slug: 'created-secret' })
    const ai = await handleManagementRequest(
        admin,
        new Request(`http://localhost/api/site-admin/entries/${entry.id}/ai/unknown`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        }),
    )
    expect(ai.status).toBe(404)
    expect(await ai.text()).not.toContain('secret')
    const relationConfig = defineSiteAdminConfig({
        ...config,
        models: {
            posts: { fields: { required: relation('targets', { required: true }) } },
            targets: { fields: { title: text() } },
        },
    })
    // Validation errors for an existing draft can also contain private relation IDs.
    const relationAdmin = await createMigratedTestAdmin({
        database: database(),
        config: relationConfig,
        authorize: () => ({ id: 'operator', roles: ['operator'] }),
    })
    const target = await relationAdmin.createEntry('targets', { id: 'hidden-target', data: { title: 'hidden' } })
    const related = await relationAdmin.createEntry('posts', { data: { required: target.id } })
    const blocked = await handleManagementRequest(
        relationAdmin,
        new Request(`http://localhost/api/site-admin/entries/${related.id}/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedVersion: related.version }),
        }),
    )
    expect(blocked.status).toBe(409)
    const error = await blocked.json()
    expect(error).toMatchObject({ error: { code: 'SITE_ADMIN_RELATION_BLOCKED' } })
    expect(error.error).not.toHaveProperty('issues')
    expect(JSON.stringify(error)).not.toContain('hidden-target')
    roles = ['admin']
    const full = await handleManagementRequest(
        admin,
        new Request(`http://localhost/api/site-admin/entries/${entry.id}/sort`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedVersion: entry.version, sortOrder: 2 }),
        }),
    )
    expect(await full.json()).toMatchObject({ data: { title: 'another secret' }, slug: 'secret-slug' })
})

it('paginates after permission and search filtering with stable ties and explicit invalid bounds', async () => {
    const admin = await createMigratedTestAdmin({
        database: database(),
        now: () => new Date('2026-01-01'),
        authorize: () => ({ id: 'reader', roles: ['reader'] }),
        config: defineSiteAdminConfig({
            authorization: defineSiteAdminAuthorization({ reader: { models: { posts: ['readDraft'] } } }),
            models: {
                posts: { fields: { title: text() } },
                secrets: { fields: { title: text() } },
            },
        }),
    })
    for (let index = 0; index < 101; index++)
        await admin.createEntry('posts', {
            id: `item-${String(index).padStart(3, '0')}`,
            data: { title: index % 10 === 0 ? 'match' : 'other' },
        })
    await admin.createEntry('secrets', { data: { title: 'match secret' } })
    const get = (query = '') =>
        handleManagementRequest(admin, new Request(`http://localhost/api/site-admin/entries${query}`))
    expect(await (await get()).json()).toMatchObject({ items: expect.any(Array), total: 101, limit: 50, offset: 0 })
    const first = await (await get('?limit=100')).json()
    const last = await (await get('?limit=100&offset=100')).json()
    expect(first.items).toHaveLength(100)
    expect(last.items.map((item: { id: string }) => item.id)).toEqual(['item-100'])
    expect(new Set([...first.items, ...last.items].map((item: { id: string }) => item.id)).size).toBe(101)
    expect(await (await get('?q=match&limit=1&offset=10')).json()).toMatchObject({
        total: 11,
        items: [{ id: 'item-100' }],
        limit: 1,
        offset: 10,
    })
    for (const query of ['?limit=101', '?limit=NaN', '?limit=0', '?offset=-1', '?offset=0.5', '?offset=Infinity'])
        expect((await get(query)).status).toBe(400)
    expect(managementAssetUrl('asset/name', '/manage/')).toBe('/manage/assets/asset%2Fname/content')
})

it('rejects depth 17 and repeated DAG amplification during publication and public projection', async () => {
    const db = database()
    const admin = await createMigratedTestAdmin({
        database: db,
        config: defineSiteAdminConfig({
            models: {
                nodes: { fields: { left: relation('nodes'), right: relation('nodes') }, route: true },
            },
        }),
    })
    let previous: string | undefined
    for (let index = 0; index <= 17; index++) {
        const entry = await admin.createEntry('nodes', {
            id: `chain-${index}`,
            slug: `chain-${index}`,
            data: previous ? { left: previous } : {},
        })
        if (index <= 16) await admin.publishEntry(entry.id, { expectedVersion: entry.version })
        else {
            await expect(admin.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
                code: 'SITE_ADMIN_RELATION_LIMIT',
            })
            // A legacy graph must also be rejected at the read boundary.
            await db
                .prepare(
                    "UPDATE site_admin_entries SET published_revision_id = current_revision_id, published_at = '2026-01-01' WHERE id = ?",
                )
                .run(entry.id)
        }
        previous = entry.id
    }
    expect(await admin.getPublicEntry('nodes', 'chain-16')).not.toBeNull()
    await expect(admin.getPublicEntry('nodes', 'chain-17')).rejects.toMatchObject({ code: 'SITE_ADMIN_RELATION_LIMIT' })
    const binary = await createMigratedTestAdmin({
        database: database(),
        config: defineSiteAdminConfig({
            models: {
                nodes: { fields: { left: relation('nodes'), right: relation('nodes') }, route: true },
            },
        }),
    })
    previous = undefined
    for (let index = 0; index <= 13; index++) {
        const entry = await binary.createEntry('nodes', {
            id: `dag-${index}`,
            slug: `dag-${index}`,
            data: previous ? { left: previous, right: previous } : {},
        })
        if (index <= 12) await binary.publishEntry(entry.id, { expectedVersion: entry.version })
        else
            await expect(binary.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
                code: 'SITE_ADMIN_RELATION_LIMIT',
            })
        previous = entry.id
    }
    expect(await binary.getPublicEntry('nodes', 'dag-12')).not.toBeNull()
    expect(await binary.resolvePath('/nodes/dag-12')).toMatchObject({ kind: 'page' })
    await expect(binary.listPublicEntries('nodes')).rejects.toMatchObject({ code: 'SITE_ADMIN_RELATION_LIMIT' })
    const response = await handlePublicRequest(binary, new Request('http://localhost/api/content/nodes'))
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'SITE_ADMIN_RELATION_LIMIT' } })
})

const separated = async (separateDrafts = true) => {
    const db = database()
    const draft = new Files({ adapter: memory() })
    const publicFiles = new Files({ adapter: memory() })
    let time = Date.parse('2026-01-01')
    const config = defineSiteAdminConfig({
        assets: { storage: 'content', separateDrafts, operationLeaseSeconds: 1, cleanup: { minimumAge: 0 } },
        models: {
            posts: { fields: { attachment: file(), body: markdown(), title: text() } },
            auto: { fields: { attachment: file() }, publishing: false },
            private: { fields: { attachment: file() }, publishing: false, public: false },
        },
    })
    const options = {
        config,
        database: db,
        getFiles: async (name: string) => (name === 'draft' ? draft : publicFiles),
        now: () => new Date(time),
    }
    const admin = await createMigratedTestAdmin(options)
    return {
        admin,
        config,
        db,
        draft,
        publicFiles,
        options,
        advance: () => {
            time += 2000
        },
    }
}

it('keeps originals private and synchronizes all publication, revision, history, schedule and GC paths', async () => {
    const { admin, draft, publicFiles, advance } = await separated()
    const asset = await admin.uploadAsset({ body: 'private original', filename: 'file.txt' })
    const replacement = await admin.uploadAsset({ body: 'new original', filename: 'new.txt' })
    expect(asset.storage).toBe('draft')
    expect(await draft.exists(asset.key)).toBe(true)
    expect((await publicFiles.list()).items.length).toBe(0)
    let first = await admin.createEntry('posts', { data: { attachment: asset.id, title: 'first' } })
    let second = await admin.createEntry('posts', { data: { body: `![](site-admin://asset/${asset.id})` } })
    first = await admin.publishEntry(first.id, { expectedVersion: first.version })
    second = await admin.publishEntry(second.id, { expectedVersion: second.version })
    expect((await publicFiles.list()).items.length).toBe(1)
    expect(await (await admin.downloadAsset(asset.id)).file.text()).toBe('private original')
    const oldRevision = first.revisionId
    first = await admin.updateEntry(first.id, { expectedVersion: first.version, data: { attachment: replacement.id } })
    expect((await publicFiles.list()).items.length).toBe(1)
    first = await admin.publishEntry(first.id, { expectedVersion: first.version })
    expect((await publicFiles.list()).items.length).toBe(2)
    second = await admin.unpublishEntry(second.id, { expectedVersion: second.version })
    expect((await publicFiles.list()).items.length).toBe(1)
    expect(await draft.exists(asset.key)).toBe(true)
    first = await admin.restoreRevision(first.id, oldRevision, { expectedVersion: first.version })
    expect((await publicFiles.list()).items.length).toBe(1)
    first = await admin.schedulePublish(first.id, { expectedVersion: first.version, at: '2026-01-01T00:00:01Z' })
    advance()
    expect(await admin.publishDue()).toMatchObject({ published: [first.id], assets: { failed: [] } })
    expect((await publicFiles.list()).items.length).toBe(1)
    first = await admin.getEntry(first.id)
    await admin.deleteEntry(first.id, { expectedVersion: first.version })
    expect((await publicFiles.list()).items.length).toBe(0)
    await admin.deleteEntry(second.id, { expectedVersion: second.version })
    expect((await admin.runAssetGC()).deleted.sort()).toEqual([asset.id, replacement.id].sort())
    expect((await draft.list()).items.length).toBe(0)
    const autoAsset = await admin.uploadAsset({ body: 'auto', filename: 'auto.txt' })
    let auto = await admin.createEntry('auto', { data: { attachment: autoAsset.id } })
    expect((await publicFiles.list()).items.length).toBe(1)
    auto = await admin.updateEntry(auto.id, { expectedVersion: auto.version, data: {} })
    expect((await publicFiles.list()).items.length).toBe(0)
    await admin.createEntry('private', { data: { attachment: autoAsset.id } })
    expect((await publicFiles.list()).items.length).toBe(0)
    expect(await draft.exists(autoAsset.key)).toBe(true)
})

it('preserves populated Markdown ledgers, original revisions and asset policy across the AST projection', async () => {
    const { admin, db, draft, publicFiles } = await separated()
    const image = await admin.uploadAsset({ body: 'image', filename: 'image.txt' })
    const example = await admin.uploadAsset({ body: 'example', filename: 'example.txt' })
    const uri = `site-admin://asset/${image.id}`
    const exampleUri = `site-admin://asset/${example.id}`
    const body = `Intro ![image](${uri})\r\n\r\n<!-- more -->\r\n\r\n[download][asset]\r\n\r\n[asset]: ${uri}\r\n\r\n\`${exampleUri}\`\r\n`
    const ledger = (revision: string) =>
        db
            .prepare(
                'SELECT asset_id, field_path, position FROM site_admin_asset_refs WHERE revision_id = ? ORDER BY position',
            )
            .bind(revision)
            .all()
    let entry = await admin.createEntry('posts', { data: { body, title: 'Markdown' } })
    const revision = entry.revisionId
    const expectedLedger = [
        { asset_id: image.id, field_path: 'body.$markdown', position: 0 },
        { asset_id: image.id, field_path: 'body.$markdown', position: 1 },
        { asset_id: example.id, field_path: 'body.$markdown', position: 2 },
    ]
    expect(await ledger(revision)).toEqual(expectedLedger)
    expect(entry.data.body).toBe(body)
    await expect(admin.downloadAsset(image.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_NOT_PUBLIC' })
    await expect(admin.createEntry('posts', { data: { body: '`site-admin://asset/missing`' } })).rejects.toMatchObject({
        code: 'SITE_ADMIN_ASSET_NOT_READY',
    })
    await expect(
        admin.createEntry('posts', { data: { body: '![missing](site-admin://asset/missing)' } }),
    ).rejects.toMatchObject({ code: 'SITE_ADMIN_ASSET_NOT_READY' })

    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    expect(await ledger(revision)).toEqual(expectedLedger)
    expect((await admin.getEntry(entry.id)).data.body).toBe(body)
    expect((await admin.getPublicEntry('posts', entry.id))?.data.body).toBe(
        body
            .replaceAll(uri, `/api/content/_assets/${image.id}`)
            .replaceAll(exampleUri, `/api/content/_assets/${example.id}`),
    )
    const content = await admin.content('posts')
    expect(await admin.content('posts')).toBe(content)
    const item = (await content.list())[0]!
    expect(item.data.body).toMatchObject({
        nodes: expect.arrayContaining([
            ['p', {}, 'Intro ', ['img', { src: `/api/content/_assets/${image.id}`, alt: 'image' }]],
            ['p', {}, ['code', {}, exampleUri]],
        ]),
        meta: { summary: [['p', {}, 'Intro ', ['img', { src: `/api/content/_assets/${image.id}`, alt: 'image' }]]] },
    })
    expect((await publicFiles.list()).items).toHaveLength(2)
    expect(await (await admin.downloadAsset(example.id)).file.text()).toBe('example')
    await expect(admin.deleteAsset(example.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_ASSET_IN_USE' })

    entry = await admin.updateEntry(entry.id, { expectedVersion: entry.version, data: { body: 'Next' } })
    expect(await admin.content('posts')).toBe(content)
    expect((await (await admin.content('posts')).list())[0]?.data.body).toEqual(item.data.body)
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    expect(await admin.content('posts')).not.toBe(content)
    expect((await publicFiles.list()).items).toHaveLength(0)
    await expect(admin.deleteAsset(example.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_ASSET_IN_USE' })
    entry = await admin.restoreRevision(entry.id, revision, { expectedVersion: entry.version })
    expect(entry.data.body).toBe(body)
    expect(await ledger(entry.revisionId)).toEqual(expectedLedger)
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    expect((await publicFiles.list()).items).toHaveLength(2)
    expect(await draft.exists(image.key)).toBe(true)
    await db.prepare("UPDATE site_admin_assets SET state = 'deleting' WHERE id = ?").bind(image.id).run()
    expect(await admin.getPublicEntry('posts', entry.id)).toBeNull()
    await expect(admin.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
        code: 'SITE_ADMIN_ASSET_NOT_READY',
    })
    await db.prepare("UPDATE site_admin_assets SET state = 'ready' WHERE id = ?").bind(image.id).run()
    entry = await admin.unpublishEntry(entry.id, { expectedVersion: entry.version })
    expect(await (await admin.content('posts')).list()).toEqual([])
    await admin.deleteEntry(entry.id, { expectedVersion: entry.version })
    expect((await admin.runAssetGC()).deleted.sort()).toEqual([image.id, example.id].sort())
})

it('keeps old untracked encoded destinations closed without changing saved Markdown or its ledger', async () => {
    const { admin, db, publicFiles } = await separated()
    const asset = await admin.uploadAsset({ body: 'untracked', filename: 'untracked.txt' })
    const body = `![hidden](site-admin&colon;//asset/${asset.id})`
    let entry = await admin.createEntry('posts', { data: { body } })
    expect(
        await db.prepare('SELECT * FROM site_admin_asset_refs WHERE revision_id = ?').bind(entry.revisionId).all(),
    ).toEqual([])
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    expect(entry.data.body).toBe(body)
    expect((await (await admin.content('posts')).list())[0]?.data.body).toMatchObject({
        nodes: [['p', {}, ['img', { alt: 'hidden' }]]],
    })
    expect((await publicFiles.list()).items).toHaveLength(0)
    await expect(admin.downloadAsset(asset.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_NOT_PUBLIC' })
})

it('does not opt in by the draft storage name and rejects missing, aliased and unmigrated storage', async () => {
    const shared = await separated(false)
    const asset = await shared.admin.uploadAsset({ body: 'shared', filename: 'shared.txt' })
    expect(asset.storage).toBe('content')
    expect(await shared.publicFiles.exists(asset.key)).toBe(true)
    expect((await shared.draft.list()).items.length).toBe(0)
    const config = { ...shared.config, assets: { ...shared.config.assets!, separateDrafts: true } }
    const adapter = await testAdapter(shared.db, config)
    const backing = memory()
    const wrappers = { draft: new Files({ adapter: backing }), content: new Files({ adapter: backing }) }
    const aliased = await createMigratedTestAdmin({
        config,
        database: database(),
        getFiles: async (name) => wrappers[name as keyof typeof wrappers],
    })
    await expect(aliased.initialize()).rejects.toMatchObject({ code: 'SITE_ADMIN_STORAGE_UNAVAILABLE' })
    const fsWrappers = {
        draft: new Files({ adapter: fs({ root: '.tmp/alias-files' }) }),
        content: new Files({ adapter: fs({ root: '.tmp/alias-files' }) }),
    }
    const fsAliased = await createMigratedTestAdmin({
        config,
        database: database(),
        getFiles: async (name) => fsWrappers[name as keyof typeof fsWrappers],
    })
    await expect(fsAliased.initialize()).rejects.toMatchObject({ code: 'SITE_ADMIN_STORAGE_UNAVAILABLE' })
    await expect(createSiteAdmin({ ...shared.options, config, database: adapter }).initialize()).rejects.toMatchObject({
        code: 'SITE_ADMIN_MIGRATION_REQUIRED',
    })
    for (const getFiles of [
        undefined,
        async () => shared.publicFiles,
        async (name: string) => {
            if (name === 'draft') throw new Error('missing')
            return shared.publicFiles
        },
    ])
        await expect(
            createSiteAdmin({ config, database: adapter, ...(getFiles ? { getFiles } : {}) }).initialize(),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_STORAGE_UNAVAILABLE' })
    await expect(
        createSiteAdmin({
            config: { ...config, assets: { ...config.assets, storage: 'draft' } },
            database: adapter,
            getFiles: shared.options.getFiles,
        }).initialize(),
    ).rejects.toMatchObject({ code: 'SITE_ADMIN_STORAGE_UNAVAILABLE' })
})

it('retries upload and delete failures through cron and GC while preserving the original', async () => {
    const { admin, publicFiles, draft } = await separated()
    const asset = await admin.uploadAsset({ body: 'retry', filename: 'retry.txt' })
    let entry = await admin.createEntry('posts', { data: { attachment: asset.id } })
    const upload = vi.spyOn(publicFiles, 'upload').mockRejectedValueOnce(new Error('copy failed'))
    await expect(admin.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
        code: 'SITE_ADMIN_STORAGE_UNAVAILABLE',
    })
    expect(await draft.exists(asset.key)).toBe(true)
    await expect(admin.downloadAsset(asset.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_ASSET_NOT_READY' })
    upload.mockRestore()
    expect(await admin.publishDue()).toMatchObject({ assets: { copied: [asset.id], failed: [] } })
    entry = await admin.getEntry(entry.id)
    const deletion = vi.spyOn(publicFiles, 'delete').mockRejectedValueOnce(new Error('delete failed'))
    await expect(admin.unpublishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
        code: 'SITE_ADMIN_STORAGE_UNAVAILABLE',
    })
    await expect(admin.downloadAsset(asset.id)).rejects.toMatchObject({ code: 'SITE_ADMIN_NOT_PUBLIC' })
    expect((await publicFiles.list()).items.length).toBe(1)
    deletion.mockRestore()
    expect((await admin.runAssetGC()).failed).toEqual([])
    expect((await publicFiles.list()).items.length).toBe(0)
    expect(await draft.exists(asset.key)).toBe(true)
})

it('fences an expired delayed copier from a newer copy on another Core instance', async () => {
    const { admin, publicFiles, options, advance } = await separated()
    const second = await createMigratedTestAdmin(options)
    await second.initialize()
    const asset = await admin.uploadAsset({ body: 'concurrent', filename: 'concurrent.txt' })
    const entry = await admin.createEntry('posts', { data: { attachment: asset.id } })
    const upload = publicFiles.upload.bind(publicFiles)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const pending = new Promise<void>((resolve) => {
        started = resolve
    })
    vi.spyOn(publicFiles, 'upload').mockImplementationOnce(async (...args: Parameters<typeof upload>) => {
        started()
        await gate
        return upload(...args)
    })
    const old = admin.publishEntry(entry.id, { expectedVersion: entry.version }).catch((error: unknown) => error)
    await pending
    expect((await second.syncAssetCopies()).failed).toHaveLength(1)
    advance()
    expect((await second.syncAssetCopies()).failed).toEqual([])
    expect((await publicFiles.list()).items.length).toBe(1)
    release()
    expect(await old).toMatchObject({ code: 'SITE_ADMIN_STORAGE_UNAVAILABLE' })
    expect((await publicFiles.list()).items.length).toBe(1)
    expect(await (await admin.downloadAsset(asset.id)).file.text()).toBe('concurrent')
    expect((await admin.runAssetGC()).failed).toEqual([])
})
