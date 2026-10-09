import { describe, expect, it, vi } from 'vitest'
import { runSiteAdminTask, type SiteAdminTaskRuntime } from '../packages/site-admin/src/runtime/tasks'
import type { SiteAdmin } from '../packages/site-admin/src/server'

const runtime = (tasks: SiteAdminTaskRuntime['tasks'] = {}) => {
    const admin = {
        publishDue: vi.fn<SiteAdmin['publishDue']>(async () => ({ published: ['entry'], failed: [] })),
        runAssetGC: vi.fn<SiteAdmin['runAssetGC']>(async () => ({ deleted: ['orphan'], failed: [] })),
        syncAssetCopies: vi.fn<SiteAdmin['syncAssetCopies']>(async () => ({
            copied: ['asset'],
            deleted: [],
            failed: [],
        })),
    }
    return { admin, runtime: { tasks, getSiteAdmin: vi.fn(async () => admin) } }
}

describe('Site Admin Nitro tasks', () => {
    it('disables all tasks by default before resolving a database or running destructive cleanup', async () => {
        for (const options of [{}, { publishDue: false, assetGC: false, syncAssets: false }]) {
            const fixture = runtime(options)
            for (const task of ['publishDue', 'assetGC', 'syncAssets'] as const)
                await expect(runSiteAdminTask(task, fixture.runtime)).rejects.toMatchObject({
                    code: 'SITE_ADMIN_FORBIDDEN',
                })
            expect(fixture.runtime.getSiteAdmin).not.toHaveBeenCalled()
            expect(fixture.admin.runAssetGC).not.toHaveBeenCalled()
        }
    })

    it('passes native platform context and delegates enabled tasks to their existing use cases', async () => {
        const fixture = runtime({ publishDue: true, assetGC: '0 3 * * *', syncAssets: true })
        const context = { cloudflare: { env: { DB: {} }, context: {} } }
        expect(await runSiteAdminTask('publishDue', fixture.runtime, context)).toEqual({
            published: ['entry'],
            failed: [],
        })
        expect(await runSiteAdminTask('assetGC', fixture.runtime, context)).toEqual({ deleted: ['orphan'], failed: [] })
        expect(await runSiteAdminTask('syncAssets', fixture.runtime, context)).toEqual({
            copied: ['asset'],
            deleted: [],
            failed: [],
        })
        expect(fixture.runtime.getSiteAdmin).toHaveBeenCalledWith(undefined, context)
        expect(fixture.admin.publishDue).toHaveBeenCalledExactlyOnceWith()
        expect(fixture.admin.runAssetGC).toHaveBeenCalledExactlyOnceWith()
        expect(fixture.admin.syncAssetCopies).toHaveBeenCalledExactlyOnceWith()
    })

    it('preserves per-item failures and propagates initialization failures for scheduler observability', async () => {
        const fixture = runtime({ publishDue: true, assetGC: true, syncAssets: true })
        fixture.admin.publishDue.mockResolvedValue({
            published: [],
            failed: [{ entryId: 'entry', message: 'conflict' }],
        })
        fixture.admin.runAssetGC.mockResolvedValue({ deleted: [], failed: [{ id: 'asset', message: 'lease held' }] })
        fixture.admin.syncAssetCopies.mockResolvedValue({
            copied: [],
            deleted: [],
            failed: [{ id: 'asset', message: 'retry' }],
        })
        expect(await runSiteAdminTask('publishDue', fixture.runtime)).toEqual({
            published: [],
            failed: [{ entryId: 'entry', message: 'conflict' }],
        })
        expect(await runSiteAdminTask('assetGC', fixture.runtime)).toEqual({
            deleted: [],
            failed: [{ id: 'asset', message: 'lease held' }],
        })
        expect(await runSiteAdminTask('syncAssets', fixture.runtime)).toEqual({
            copied: [],
            deleted: [],
            failed: [{ id: 'asset', message: 'retry' }],
        })
        fixture.runtime.getSiteAdmin.mockRejectedValue(new Error('D1 binding unavailable'))
        await expect(runSiteAdminTask('publishDue', fixture.runtime)).rejects.toThrow('D1 binding unavailable')
    })
})
