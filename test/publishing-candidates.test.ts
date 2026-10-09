import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { MockLanguageModelV4 } from 'ai/test'
import { jsonSchema, Output } from 'ai'
import { defineSiteAdminConfig, number, text } from '../packages/site-admin/src'
import { handleManagementRequest, type SiteAdminActor } from '../packages/site-admin/src/server'
import { useSiteAdminForm } from '../packages/site-admin/src/form'
import type { SiteAdminAIAction, SiteAdminAIModel } from '../packages/site-admin/src/ai'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const setup = async (
    action: SiteAdminAIAction = ({ entry }) => ({
        data: { ...entry.data, summary: 'Application summary' },
        slug: 'chosen-by-app',
    }),
    model?: SiteAdminAIModel,
) => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    const implicitSlug = vi.fn(() => {
        throw new Error('Draft saves must not invoke AI')
    })
    const prepare = vi.fn(action)
    let actor: SiteAdminActor | null = { id: 'admin', roles: ['admin'] }
    let sequence = 0
    const config = defineSiteAdminConfig({
        ai: {
            ...(model ? { model } : {}),
            slug: implicitSlug,
            models: { notes: { publication: prepare }, inventory: { classify: prepare } },
        },
        authorization: {
            roles: {
                publisher: { models: { notes: ['publish'] } },
                editor: { models: { notes: ['readDraft', 'update', 'ai'] } },
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
        aiEnabled: true,
        id: () => `id-${++sequence}`,
    })
    return {
        admin,
        prepare,
        implicitSlug,
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
        const { admin, implicitSlug } = await setup()
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
        expect(implicitSlug).not.toHaveBeenCalled()
    })

    it('preserves explicit slug and empty-slug validation for non-publishing forms', async () => {
        const { admin, implicitSlug } = await setup()
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
        expect(implicitSlug).not.toHaveBeenCalled()
    })

    it('runs native caller-owned output through the configured model with native request/platform context', async () => {
        const run = vi.fn<MockLanguageModelV4['doGenerate']>(async () => ({
            content: [{ type: 'text', text: '{"title":"Generated by app"}' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
        }))
        const model = new MockLanguageModelV4({ doGenerate: run })
        const resolve = vi.fn(async () => model)
        const { admin } = await setup(async ({ entry, ai }) => {
            if (!ai) throw new Error('AI unavailable')
            const generated = await ai({
                prompt: JSON.stringify(entry.data),
                output: Output.object({
                    schema: jsonSchema<{ title: string }>({
                        type: 'object',
                        properties: { title: { type: 'string' } },
                        required: ['title'],
                    }),
                }),
                maxRetries: 0,
            })
            return { data: { ...entry.data, title: generated.output.title } }
        }, resolve)
        const entry = await admin.createEntry('notes', { data: { title: 'Stored' }, slug: '' })
        expect(resolve).not.toHaveBeenCalled()
        const platform = { binding: 'native-platform' }
        const actionRequest = request(`entries/${entry.id}/ai/publication`, {
            expectedVersion: entry.version,
            draft: { data: { title: 'Unsaved' }, slug: '' },
        })
        const response = await handleManagementRequest(admin, actionRequest, '/api/site-admin', { context: platform })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            data: { title: 'Generated by app' },
            version: entry.version,
            slug: '',
        })
        expect(resolve).toHaveBeenCalledWith({ request: actionRequest, platformContext: platform })
        expect((await admin.getEntry(entry.id)).data.title).toBe('Stored')
        expect(run).toHaveBeenCalledTimes(1)
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
        const { admin, implicitSlug, prepare } = await setup()
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
        expect(implicitSlug).not.toHaveBeenCalled()
        expect(prepare).not.toHaveBeenCalled()
    })

    it('keeps title-derived legacy create/publish working without invoking config.ai.slug', async () => {
        const { admin, implicitSlug } = await setup()
        const draft = await admin.createEntry('notes', { data: { title: 'Legacy title' } })
        expect(draft.slug).toBe('legacy-title')
        await admin.publishEntry(draft.id, { expectedVersion: draft.version })
        expect((await admin.getPublicEntry('notes', draft.id))?.slug).toBe('legacy-title')
        expect(implicitSlug).not.toHaveBeenCalled()
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

    it('passes unsaved snapshot and native request context to application actions without saving', async () => {
        const { admin, prepare } = await setup()
        const entry = await admin.createEntry('notes', { data: { title: 'Stored' }, slug: '' })
        const response = await handleManagementRequest(
            admin,
            request(`entries/${entry.id}/ai/publication`, {
                expectedVersion: entry.version,
                draft: { data: { title: 'Unsaved', summary: '' }, slug: '' },
                input: { mode: 'auto' },
            }),
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            version: entry.version,
            baseRevisionId: entry.currentRevisionId,
            data: { title: 'Unsaved', summary: 'Application summary' },
            slug: 'chosen-by-app',
        })
        expect(prepare.mock.calls[0]?.[0]).toMatchObject({
            entry: { id: entry.id, data: { title: 'Unsaved' }, slug: '' },
            input: { mode: 'auto' },
            context: { request: expect.any(Request) },
        })
        expect(await admin.getEntry(entry.id)).toEqual(entry)
        expect(await admin.listRevisions(entry.id)).toHaveLength(1)
    })

    it('allows non-blog actions without any title, excerpt or proofreading fields', async () => {
        const { admin } = await setup(({ entry }) => ({ data: { quantity: Number(entry.data.quantity) + 1 } }))
        const entry = await admin.createEntry('inventory', { data: { quantity: 3 }, slug: '' })
        expect(admin.descriptor.models.inventory?.ai).toBe(true)
        const proposal = await admin.runAIAction(entry.id, 'classify', {
            expectedVersion: entry.version,
            draft: { data: { quantity: 7 }, slug: '' },
        })
        expect(proposal).toMatchObject({ data: { quantity: 8 }, slug: '', issues: [] })
        expect((await admin.getEntry(entry.id)).data).toEqual({ quantity: 3 })
    })

    it('keeps drafts on failed AI, allows retry, rejects stale versions and enforces AI/read permissions', async () => {
        const { admin, prepare, actor } = await setup()
        const entry = await admin.createEntry('notes', { data: { title: 'Keep' }, slug: '' })
        prepare.mockRejectedValueOnce(new Error('Provider 402 details'))
        const input = { expectedVersion: entry.version, draft: { data: { title: 'Unsaved' }, slug: '' } }
        const failed = await handleManagementRequest(admin, request(`entries/${entry.id}/ai/publication`, input))
        expect(failed.status).toBe(502)
        expect(await failed.text()).not.toContain('402')
        expect(await admin.getEntry(entry.id)).toEqual(entry)
        expect(
            (await handleManagementRequest(admin, request(`entries/${entry.id}/ai/publication`, input))).status,
        ).toBe(200)
        const updated = await admin.updateEntry(entry.id, {
            expectedVersion: entry.version,
            data: { title: 'Elsewhere' },
        })
        const previousCalls = prepare.mock.calls.length
        expect(
            (await handleManagementRequest(admin, request(`entries/${entry.id}/ai/publication`, input))).status,
        ).toBe(409)
        expect(prepare.mock.calls).toHaveLength(previousCalls)
        actor({ id: 'reader', roles: ['reader'] })
        expect(
            (
                await handleManagementRequest(
                    admin,
                    request(`entries/${entry.id}/ai/publication`, { ...input, expectedVersion: updated.version }),
                )
            ).status,
        ).toBe(403)
    })

    it('rejects a result if the stored version changes while the application AI action is running', async () => {
        const pending = Promise.withResolvers<{ data: Record<string, unknown> }>()
        const started = Promise.withResolvers<void>()
        const { admin } = await setup(() => {
            started.resolve()
            return pending.promise
        })
        const entry = await admin.createEntry('notes', { data: { title: 'Original' }, slug: 'original' })
        const generating = admin.runAIAction(entry.id, 'publication', {
            expectedVersion: entry.version,
            draft: { data: { title: 'Unsaved' } },
        })
        const rejected = expect(generating).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        await started.promise
        await admin.updateEntry(entry.id, { expectedVersion: entry.version, data: { title: 'Changed' } })
        pending.resolve({ data: { title: 'Late' } })
        await rejected
        expect((await admin.getEntry(entry.id)).data.title).toBe('Changed')
        expect(await admin.routeSnapshot()).toEqual([])
    })
})
