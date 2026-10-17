import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { Output } from 'ai'
import { z } from 'zod'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { executeSiteAdminAiAction } from '../packages/site-admin/src/ai'
import { handleAiActionRequest } from '../packages/site-admin/src/server/ai-actions-http'
import { useEntryForm } from '../packages/site-admin/src/form'
import { createSiteAdmin, handleManagementRequest } from '../packages/site-admin/src/server'
import { createMemoryDatabase } from './memory-storage'
import { modelFixture } from './model-fixture'

const generated = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
})
const setup = (run: MockLanguageModelV4['doGenerate']) => {
    const platformContext = { binding: 'native-app' }
    const model = new MockLanguageModelV4({ doGenerate: run })
    const modelResolver = vi.fn(async () => model)
    const config = defineSiteAdminConfig({
        models: { notes: { fields: { slug: text(), title: text({ required: true }), summary: text() } } },
        ai: {
            model: modelResolver,
            actions: {
                prepare: {
                    type: 'text-generation',
                    input: z.object({ content: z.string() }).strict(),
                    prompt: ({ content }) => content,
                    output: Output.object({
                        schema: z.object({
                            data: z.object({ title: z.string().optional(), summary: z.string().optional() }),
                        }),
                    }),
                },
            },
        },
    })
    const actor = { id: 'admin', roles: ['admin'] }
    const database = createMemoryDatabase()
    const assertSchema = vi.spyOn(database.storage, 'assertSchema')
    const commit = vi.spyOn(database.storage, 'commit')
    const admin = createSiteAdmin({ config, database, authorize: () => actor })
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return String(input).includes('/ai/actions/')
            ? handleAiActionRequest(request, '/api/site-admin', (name, payload) =>
                  executeSiteAdminAiAction(config, name, payload, { actor, request, platformContext }),
              )
            : handleManagementRequest(admin, request)
    }
    return { admin, database, assertSchema, commit, fetch, modelResolver, platformContext }
}

describe('app-owned native AI with resource forms', () => {
    it('does not initialize CMS or save when generating an explicit proposal', async () => {
        const run = vi.fn(async () => generated({ data: { summary: 'Proposed' } }))
        const { admin, fetch, assertSchema, commit, modelResolver, platformContext } = setup(run)
        const fixture = modelFixture(fetch, null, {}, { model: 'notes', descriptor: admin.descriptor.models.notes! })
        const formState = useEntryForm(fixture.resource, { defaultValues: { title: 'Manual' } })
        const before = formState.draft.snapshot()
        const result = (await fixture.client.runAiAction('prepare', { input: { content: 'Manual' } })) as {
            data: { summary: string }
        }
        expect(formState.draft.isStale(before)).toBe(false)
        expect(assertSchema).not.toHaveBeenCalled()
        expect(commit).not.toHaveBeenCalled()
        expect(modelResolver).toHaveBeenCalledWith({
            actor: { id: 'admin', roles: ['admin'] },
            request: expect.any(Request),
            platformContext,
        })
        formState.form.setFieldValue('summary', result.data.summary)
        await formState.form.handleSubmit()
        expect(fixture.resource.error.value).toBeUndefined()
        expect(commit).toHaveBeenCalledOnce()
        expect((await admin.getEntry(formState.draft.snapshot().entryId!)).data).toEqual({
            title: 'Manual',
            summary: 'Proposed',
        })
        expect(run).toHaveBeenCalledOnce()
    })
    it('preserves the input and optimistic version if another writer commits during AI generation', async () => {
        const pending = Promise.withResolvers<Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>>()
        const started = Promise.withResolvers<void>()
        const { admin, fetch } = setup(async () => {
            started.resolve()
            return pending.promise
        })
        const entry = await admin.createEntry('notes', { data: { slug: '', title: 'Stored' } })
        const fixture = modelFixture(fetch, entry, {}, { model: 'notes', descriptor: admin.descriptor.models.notes! })
        const formState = useEntryForm(fixture.resource)
        const proposal = fixture.client.runAiAction('prepare', { input: { content: 'Stored' } })
        await started.promise
        await admin.updateEntry(entry.id, {
            expectedVersion: entry.version,
            data: { slug: entry.data.slug, title: 'Elsewhere' },
        })
        pending.resolve(generated({ data: { summary: 'Proposed' } }))
        const result = (await proposal) as { data: { summary: string } }
        formState.form.setFieldValue('summary', result.data.summary)
        await formState.form.handleSubmit()
        expect(fixture.resource.error.value?.data?.code).toBe('SITE_ADMIN_CONFLICT')
        expect(formState.draft.snapshot().version).toBe(entry.version)
        expect(formState.form.state.values).toEqual({ title: 'Stored', summary: 'Proposed', slug: '' })
        expect((await admin.getEntry(entry.id)).data.title).toBe('Elsewhere')
    })
})
