import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { Files, type Body, type StoredFile, type UploadOptions } from 'files-sdk'
import { memory } from 'files-sdk/memory'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { createSiteAdmin, handleManagementRequest, handlePublicRequest } from '../packages/site-admin/src/server'
import { prepareUpload } from '../packages/site-admin/src/server/upload'
import { createMigratedTestAdmin, migrateTestDatabase, testAdapter } from './migrate'

const databases: Database[] = []
type SingleUpload = { upload: (key: string, body: Body, options?: UploadOptions) => Promise<StoredFile> }
afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(databases.splice(0).map((db) => db.dispose()))
})
const setup = async (maxUploadSize?: number) => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    const files = new Files({ adapter: memory() })
    const admin = await createMigratedTestAdmin({
        authorize: () => ({ id: 'admin', roles: ['admin'] }),
        config: defineSiteAdminConfig({
            assets: { storage: 'content', ...(maxUploadSize === undefined ? {} : { maxUploadSize }) },
            models: {
                posts: { fields: { title: text() }, sortable: true, publishing: false, route: true },
                private: { fields: { title: text() }, sortable: true },
            },
        }),
        database,
        getFiles: async () => files,
        locales: { defaultLocale: 'en', supported: ['en', 'ja'] },
    })
    return { admin, files }
}

it('rejects cross-origin mutations and non-JSON bodies, while permitting same-origin and machine clients', async () => {
    const { admin } = await setup()
    for (const headers of [
        { origin: 'https://evil.example.com' },
        { origin: 'null' },
        { 'sec-fetch-site': 'same-site' },
        { 'sec-fetch-site': 'cross-site' },
    ]) {
        const response = await handleManagementRequest(
            admin,
            new Request('https://example.com/api/site-admin/tasks/asset-gc', { method: 'POST', headers }),
        )
        expect(response.status).toBe(403)
    }
    for (const headers of [{ origin: 'https://example.com' }, { 'sec-fetch-site': 'same-origin' }, {}]) {
        const response = await handleManagementRequest(
            admin,
            new Request('https://example.com/api/site-admin/entries/posts', {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ data: { title: crypto.randomUUID() } }),
            }),
        )
        expect(response.status).toBe(201)
    }
    for (const [type, body] of [
        ['text/plain', '{"data":{}}'],
        ['application/json', '{'],
    ]) {
        expect(
            (
                await handleManagementRequest(
                    admin,
                    new Request('https://example.com/api/site-admin/entries/posts', {
                        method: 'POST',
                        headers: { 'content-type': type! },
                        body: body!,
                    }),
                )
            ).status,
        ).toBe(400)
    }
    const file = new File(['hello'], '日本語.txt')
    expect(
        (
            await handleManagementRequest(
                admin,
                new Request('https://example.com/api/site-admin/assets', {
                    method: 'POST',
                    body: file,
                    headers: { 'x-filename': encodeURIComponent(file.name), 'x-upload-size': String(file.size) },
                }),
            )
        ).status,
    ).toBe(201)
})

it('validates direct view arguments and rejects unsupported route locales', async () => {
    const { admin } = await setup()
    const entry = await admin.createEntry('posts', { data: { title: 'safe' } })
    for (const view of ["current' || (SELECT name FROM sqlite_master) || '", 'invalid'])
        await expect(admin.referencesTo(entry.id, { view: view as 'current' })).rejects.toMatchObject({
            code: 'SITE_ADMIN_INVALID_INPUT',
        })
    expect(await admin.referencesTo(entry.id, { view: 'published' })).toEqual([])
    for (let index = 0; index < 70; index++)
        expect(
            (
                await handlePublicRequest(
                    admin,
                    new Request(`https://example.com/api/content/_route?path=/posts/safe&locale=invalid-${index}`),
                )
            ).status,
        ).toBe(400)
    expect(await admin.resolvePath('/posts/safe', 'en')).toMatchObject({ kind: 'page' })
})

it('reorders atomically with conflicts, wrong models and duplicate IDs', async () => {
    const { admin } = await setup()
    const entries = await Promise.all(['one', 'two'].map((title) => admin.createEntry('posts', { data: { title } })))
    const items = entries.map((entry, sortOrder) => ({ id: entry.id, sortOrder, expectedVersion: entry.version }))
    const generation = await admin.publicGeneration()
    await expect(
        admin.setSortOrders('posts', [items[0]!, { ...items[1]!, expectedVersion: 99 }]),
    ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
    expect(await admin.publicGeneration()).toBe(generation)
    expect((await admin.getEntry(entries[0]!.id)).version).toBe(entries[0]!.version)
    await expect(admin.setSortOrders('private', items)).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
    await expect(admin.setSortOrders('posts', [items[0]!, items[0]!])).rejects.toMatchObject({
        code: 'SITE_ADMIN_INVALID_INPUT',
    })
    const sorted = await admin.setSortOrders('posts', items)
    expect(sorted.map((entry) => entry.sortOrder)).toEqual([0, 1])
    expect(await admin.publicGeneration()).toBe(generation + 1)
})

it('streams beyond 10 MB with backpressure and incremental checksums', async () => {
    const { admin, files } = await setup()
    const chunk = new Uint8Array(64 * 1024).fill(42)
    const count = 180
    let produced = 0
    let consumed = 0
    const hash = createHash('sha256')
    vi.spyOn(files as unknown as SingleUpload, 'upload').mockImplementation(async (_key, body) => {
        const reader = (body as ReadableStream<Uint8Array>).getReader()
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            consumed += value.length
            hash.update(value)
            expect(produced * chunk.length - consumed).toBeLessThanOrEqual(chunk.length * 2)
            await new Promise((resolve) => setTimeout(resolve, 1))
        }
        return { size: consumed } as StoredFile
    })
    const body = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                if (produced++ < count) controller.enqueue(chunk)
                else {
                    produced--
                    controller.close()
                }
            },
        },
        { highWaterMark: 0 },
    )
    const asset = await admin.uploadAsset({ body, filename: 'large.bin', size: chunk.length * count })
    expect(asset).toMatchObject({ state: 'ready', size: chunk.length * count, checksum: hash.digest('hex') })
    expect(admin.descriptor.assets).not.toHaveProperty('maxUploadSize')
})

it('rejects inaccurate lengths, aborted streams and explicit caps, and cleans failed storage writes', async () => {
    const { admin, files } = await setup()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
    const split = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const byte of png) controller.enqueue(new Uint8Array([byte]))
            controller.close()
        },
    })
    expect(await admin.uploadAsset({ body: split, size: png.length, filename: 'split.png' })).toMatchObject({
        contentType: 'image/png',
        size: png.length,
    })
    for (const size of [3, 30]) {
        await expect(
            admin.uploadAsset({ body: new Blob(['abcdefghijklmnop']).stream(), size, filename: 'bad.bin' }),
        ).rejects.toThrow()
    }
    const aborted = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.error(new Error('aborted'))
        },
    })
    await expect(admin.uploadAsset({ body: aborted, size: 20, filename: 'abort.bin' })).rejects.toThrow('aborted')
    await expect(prepareUpload({ body: new Blob(['1234']), filename: 'limit' }, 3)).rejects.toThrow('limit')
    for (const size of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        await expect(prepareUpload({ body: new Blob(['a']).stream(), size, filename: 'invalid' })).rejects.toThrow()
    const upload = files.upload.bind(files)
    let key = ''
    vi.spyOn(files as unknown as SingleUpload, 'upload').mockImplementation(async (path, body, options) => {
        key = path
        await upload(path, body, options)
        throw new Error('provider failed after write')
    })
    await expect(admin.uploadAsset({ body: new Blob(['hello']), filename: 'failed.bin' })).rejects.toThrow(
        'provider failed',
    )
    expect(await files.exists(key)).toBe(false)
    expect((await admin.getAsset(key.split('/')[1]!)).state).toBe('upload_failed')
})

it('evicts public snapshots and routes after 64 locale keys without a locale whitelist', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    const config = defineSiteAdminConfig({
        models: { posts: { localized: true, fields: { title: text() }, route: true } },
    })
    await migrateTestDatabase(database, config)
    const storage = (await testAdapter(database, config)).bind(config)
    const admin = createSiteAdmin({ config, database: { bind: () => storage } })
    const first = await admin.content('posts', 'locale-0')
    for (let i = 1; i <= 64; i++) await admin.content('posts', `locale-${i}`)
    expect(await admin.content('posts', 'locale-0')).not.toBe(first)
    const routeReads = vi.spyOn(storage, 'routes')
    for (let i = 0; i <= 64; i++) await admin.resolvePath('/missing', `locale-${i}`)
    const before = routeReads.mock.calls.length
    await admin.resolvePath('/missing', 'locale-64')
    expect(routeReads).toHaveBeenCalledTimes(before)
    await admin.resolvePath('/missing', 'locale-0')
    expect(routeReads).toHaveBeenCalledTimes(before + 1)
    expect(routeReads).toHaveBeenLastCalledWith({ locales: ['locale-0', ''] })
})
