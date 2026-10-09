import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { MockLanguageModelV4 } from 'ai/test'
import { defineSiteAdminConfig, number, text } from '../packages/site-admin/src'
import { handleManagementRequest, type SiteAdminActor } from '../packages/site-admin/src/server'
import { useSiteAdminForm } from '../packages/site-admin/src/form'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const setup = async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    const prepare = vi.fn(async () => {
        throw new Error('Draft saves must not invoke AI')
    })
    let actor: SiteAdminActor | null = { id: 'admin', roles: ['admin'] }
    let sequence = 0
    const config = defineSiteAdminConfig({
        ai: {
            model: new MockLanguageModelV4(),
            actions: { publication: { type: 'text-generation', props: {}, prompt: prepare } },
        },
        authorization: {
            roles: {
                publisher: { models: { notes: ['publish'] } },
                editor: { models: { notes: ['readDraft', 'update'] } },
                reader: { models: { notes: ['readDraft'] } },
            },
        },
        models: {
            notes: { fields: { title: text({ required: true }), summary: text() }, route: '/notes/:slug' },
            inventory: { fields: { quantity: number({ required: true }) }, route: false },
            authors: { fields: { title: text({ required: true }) }, publishing: false, route: '/authors/:slug' },
            settings: { fields: { quantity: number({ required: true }) }, publishing: false, route: false },
        },
    })
    const admin = await createMigratedTestAdmin({
        config,
        database,
        authorize: () => actor,
        id: () => `id-${++sequence}`,
    })
    return {
        admin,
        prepare,
        actor: (value: SiteAdminActor | null) => {
            actor = value
        },
    }
}
const request = (path: string, body: unknown) =>
    new Request(`https://site.test/api/site-admin/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })

describe('application-owned AI and atomic publication candidates', () => {
    it.each([
        { model: 'authors', data: { title: 'Ada Lovelace' }, slug: 'ada-lovelace' },
        { model: 'settings', data: { quantity: 3 }, slug: 'id-1' },
    ])('creates a non-publishing $model form with its deterministic fallback slug', async ({ model, data, slug }) => {
        const { admin, prepare } = await setup()
        const controller = useSiteAdminForm<{ title?: string; quantity?: number }>({
            descriptor: admin.descriptor.models[model]!,
            modelName: model,
            defaultValues: data,
            origin: 'https://site.test',
            fetch: (input, init) => handleManagementRequest(admin, new Request(input, init)),
        })
        await controller.form.handleSubmit()
        expect(controller.serverError.value).toBeNull()
        expect(controller.entryId.value).not.toBeNull()
        const saved = await admin.getEntry(controller.entryId.value!)
        expect(saved.slug).toBe(slug)
        expect(saved.data).toEqual(data)
        expect(saved.publishedRevisionId).toBe(saved.currentRevisionId)
        expect((await admin.getPublicEntry(model, saved.id))?.slug).toBe(slug)
        if ('title' in data) controller.form.setFieldValue('title', 'Changed')
        else controller.form.setFieldValue('quantity', 4)
        await controller.form.handleSubmit()
        expect(controller.serverError.value).toBeNull()
        expect((await admin.getEntry(saved.id)).slug).toBe(slug)
        expect(prepare).not.toHaveBeenCalled()
    })

    it('preserves explicit slug and empty-slug validation for non-publishing forms', async () => {
        const { admin, prepare } = await setup()
        let controlledSlug = ''
        const controller = useSiteAdminForm({
            descriptor: admin.descriptor.models.authors!,
            modelName: 'authors',
            defaultValues: { title: 'Author' },
            slug: () => controlledSlug,
            origin: 'https://site.test',
            fetch: (input, init) => handleManagementRequest(admin, new Request(input, init)),
        })
        await controller.form.handleSubmit()
        expect(controller.serverError.value?.code).toBe('SITE_ADMIN_INVALID_INPUT')
        expect(controller.entryId.value).toBeNull()
        controlledSlug = 'chosen-author'
        await controller.form.handleSubmit()
        expect(controller.serverError.value).toBeNull()
        const saved = await admin.getEntry(controller.entryId.value!)
        expect(saved.slug).toBe(controlledSlug)
        controlledSlug = ''
        await controller.form.handleSubmit()
        expect(controller.serverError.value?.code).toBe('SITE_ADMIN_INVALID_INPUT')
        expect((await admin.getEntry(saved.id)).slug).toBe(saved.slug)
        expect(prepare).not.toHaveBeenCalled()
    })

    it('atomically stores and pins a scheduled candidate, preserving later edits and publishing the pinned revision', async () => {
        const { admin, prepare } = await setup()
        const entry = await admin.createEntry('notes', { data: { title: 'Draft' }, slug: '' })
        const response = await handleManagementRequest(
            admin,
            request(`entries/${entry.id}/schedule`, {
                at: '2098-01-01T00:00:00Z',
                expectedVersion: entry.version,
                draft: { data: { title: 'Scheduled', summary: '' }, slug: 'scheduled' },
            }),
        )
        expect(response.status).toBe(200)
        const scheduled = await admin.getEntry(entry.id)
        expect(scheduled.version).toBe(entry.version + 1)
        expect(scheduled.currentRevisionId).toBe(scheduled.scheduledRevisionId)
        expect(scheduled.publishedRevisionId).toBeNull()
        await expect(
            admin.schedulePublish(entry.id, {
                at: '2098-01-01T00:00:00Z',
                expectedVersion: entry.version,
                draft: { data: { title: 'Double' }, slug: 'double' },
            }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        expect(await admin.listRevisions(entry.id)).toHaveLength(2)
        await admin.updateEntry(entry.id, {
            expectedVersion: scheduled.version,
            data: { title: 'Later edits' },
            slug: 'later',
        })
        expect(await admin.publishDue(new Date('2099-01-01T00:00:00Z'))).toMatchObject({
            published: [entry.id],
            failed: [],
        })
        expect((await admin.getPublicEntry('notes', entry.id))?.data.title).toBe('Scheduled')
        expect((await admin.getPublicEntry('notes', entry.id))?.slug).toBe('scheduled')
        expect((await admin.getEntry(entry.id)).data.title).toBe('Later edits')
        expect(await admin.routeSnapshot()).toMatchObject([{ path: '/notes/scheduled' }])
        expect(prepare).not.toHaveBeenCalled()
    })
    it('stores unfinished metadata with zero AI calls and keeps the internal slug out of DTOs and public routes', async () => {
        const { admin, prepare } = await setup()
        const draft = await admin.createEntry('notes', { data: { title: 'Draft', summary: '' }, slug: '' })
        expect(draft.slug).toBe('')
        expect((await admin.listRevisions(draft.id))[0]?.slug).toBe('')
        expect(await admin.getPublicEntry('notes', draft.id)).toBeNull()
        expect(await admin.routeSnapshot()).toEqual([])
        await expect(admin.publishEntry(draft.id, { expectedVersion: draft.version })).rejects.toMatchObject({
            code: 'SITE_ADMIN_INVALID_INPUT',
        })
        await expect(
            admin.schedulePublish(draft.id, { expectedVersion: draft.version, at: '2099-01-01T00:00:00Z' }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
        const updated = await admin.updateEntry(draft.id, {
            expectedVersion: draft.version,
            data: { title: 'Edited' },
            slug: '',
        })
        expect(updated.slug).toBe('')
        expect(prepare).not.toHaveBeenCalled()
    })

    it('keeps title-derived legacy create/publish working without running native AI', async () => {
        const { admin, prepare } = await setup()
        const draft = await admin.createEntry('notes', { data: { title: 'Legacy title' } })
        expect(draft.slug).toBe('legacy-title')
        await admin.publishEntry(draft.id, { expectedVersion: draft.version })
        expect((await admin.getPublicEntry('notes', draft.id))?.slug).toBe('legacy-title')
        expect(prepare).not.toHaveBeenCalled()
    })

    it('atomically publishes caller data and slug with matching current/public revision and one version increment', async () => {
        const { admin, prepare } = await setup()
        const draft = await admin.createEntry('notes', { data: { title: 'Draft' }, slug: '' })
        const response = await handleManagementRequest(
            admin,
            request(`entries/${draft.id}/publish`, {
                expectedVersion: draft.version,
                draft: { data: { title: 'Published', summary: 'Manual' }, slug: 'final' },
            }),
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        const saved = await admin.getEntry(draft.id)
        expect(saved.version).toBe(draft.version + 1)
        expect(saved.currentRevisionId).toBe(saved.publishedRevisionId)
        expect(saved.data).toEqual({ title: 'Published', summary: 'Manual' })
        expect((await admin.getPublicEntry('notes', draft.id))?.data.title).toBe('Published')
        expect(await admin.routeSnapshot()).toMatchObject([{ path: '/notes/final', entryId: draft.id }])
        expect(await admin.listRevisions(draft.id)).toHaveLength(2)
        expect(prepare).not.toHaveBeenCalled()
    })

    it('preserves existing published slug when candidate omits it and rejects explicit manual empty slug', async () => {
        const { admin } = await setup()
        let entry = await admin.createEntry('notes', { data: { title: 'Original' }, slug: 'stable-url' })
        entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
        entry = await admin.publishEntry(entry.id, {
            expectedVersion: entry.version,
            draft: { data: { title: 'Updated', summary: '' } },
        })
        expect(entry.slug).toBe('stable-url')
        expect(entry.data.summary).toBe('')
        await expect(
            admin.publishEntry(entry.id, {
                expectedVersion: entry.version,
                draft: { data: { title: 'Bad' }, slug: '' },
            }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
        expect((await admin.getEntry(entry.id)).version).toBe(entry.version)
        expect((await admin.getPublicEntry('notes', entry.id))?.slug).toBe('stable-url')
    })

    it('rejects stale/double publication without extra revisions and supports a refreshed retry', async () => {
        const { admin } = await setup()
        const entry = await admin.createEntry('notes', { data: { title: 'Draft' }, slug: 'original' })
        const input = { expectedVersion: entry.version, draft: { data: { title: 'First' }, slug: 'first' } }
        const results = await Promise.allSettled([
            admin.publishEntry(entry.id, input),
            admin.publishEntry(entry.id, input),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
            { reason: { code: 'SITE_ADMIN_CONFLICT' } },
        ])
        expect(await admin.listRevisions(entry.id)).toHaveLength(2)
        const latest = await admin.getEntry(entry.id)
        const retry = await admin.publishEntry(entry.id, {
            expectedVersion: latest.version,
            draft: { data: { title: 'Retry' }, slug: 'retry' },
        })
        expect(retry.version).toBe(entry.version + 2)
        expect(retry.currentRevisionId).toBe(retry.publishedRevisionId)
    })

    it('rolls back candidate revision/current pointer/version on route conflict', async () => {
        const { admin } = await setup()
        const occupying = await admin.createEntry('notes', { data: { title: 'Occupying' }, slug: 'taken' })
        await admin.publishEntry(occupying.id, { expectedVersion: occupying.version })
        const draft = await admin.createEntry('notes', { data: { title: 'Keep' }, slug: 'draft' })
        await expect(
            admin.publishEntry(draft.id, {
                expectedVersion: draft.version,
                draft: { data: { title: 'Candidate' }, slug: 'taken' },
            }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_ROUTE_CONFLICT' })
        expect(await admin.getEntry(draft.id)).toMatchObject({
            version: draft.version,
            currentRevisionId: draft.currentRevisionId,
            publishedRevisionId: null,
            data: { title: 'Keep' },
        })
        expect(await admin.listRevisions(draft.id)).toHaveLength(1)
    })

    it.each([
        { draft: { data: {} }, revisionId: 'revision' },
        { draft: null },
        { draft: { data: [] } },
        { draft: { data: {}, slug: 1 } },
    ])('rejects ambiguous or malformed publish inputs %j', async (invalid) => {
        const { admin } = await setup()
        const entry = await admin.createEntry('notes', { data: { title: 'Draft' } })
        const response = await handleManagementRequest(
            admin,
            request(`entries/${entry.id}/publish`, { expectedVersion: entry.version, ...invalid }),
        )
        expect(response.status).toBe(400)
        expect((await admin.getEntry(entry.id)).version).toBe(entry.version)
        expect(await admin.listRevisions(entry.id)).toHaveLength(1)
    })

    it('keeps revisionId API and permissions, requiring both publish and update for a candidate', async () => {
        const { admin, actor } = await setup()
        const entry = await admin.createEntry('notes', { data: { title: 'Legacy' } })
        actor({ id: 'publisher', roles: ['publisher'] })
        const rejected = await handleManagementRequest(
            admin,
            request(`entries/${entry.id}/publish`, {
                expectedVersion: entry.version,
                draft: { data: { title: 'Candidate' } },
            }),
        )
        expect(rejected.status).toBe(403)
        const published = await handleManagementRequest(
            admin,
            request(`entries/${entry.id}/publish`, {
                expectedVersion: entry.version,
                revisionId: entry.currentRevisionId,
            }),
        )
        expect(published.status).toBe(200)
        expect(await published.json()).not.toHaveProperty('data')
        actor({ id: 'editor', roles: ['editor'] })
        const latest = await admin.getEntry(entry.id)
        expect(
            (
                await handleManagementRequest(
                    admin,
                    request(`entries/${entry.id}/publish`, {
                        expectedVersion: latest.version,
                        draft: { data: { title: 'Editor' } },
                    }),
                )
            ).status,
        ).toBe(403)
        actor(null)
        expect(
            (
                await handleManagementRequest(
                    admin,
                    request(`entries/${entry.id}/publish`, { expectedVersion: latest.version }),
                )
            ).status,
        ).toBe(401)
    })
})
