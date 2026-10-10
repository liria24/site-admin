import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { Output } from 'ai'
import { z } from 'zod'
import {
    array,
    createSiteAdminDescriptor,
    defineSiteAdminConfig,
    object,
    select,
    text,
} from '../packages/site-admin/src'
import { executeSiteAdminAiAction } from '../packages/site-admin/src/ai'
import { handleAiActionRequest } from '../packages/site-admin/src/server/ai-actions-http'
import { useSiteAdminForm } from '../packages/site-admin/src/form'
import { createSiteAdmin, handleManagementRequest } from '../packages/site-admin/src/server'
import { createMemoryDatabase } from './memory-storage'
import { reactive } from 'vue'

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
        models: { notes: { fields: { title: text({ required: true }), summary: text() } } },
        ai: {
            model: modelResolver,
            actions: {
                prepare: {
                    type: 'text-generation',
                    props: { content: z.string() },
                    prompt: ({ content }) => content,
                    output: Output.object({
                        schema: z.object({
                            data: z.object({ title: z.string().optional(), summary: z.string().optional() }),
                            slug: z.string().optional(),
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
            ? handleAiActionRequest(request, '/api/site-admin', (name, props) =>
                  executeSiteAdminAiAction(config, name, props, { actor, request, platformContext }),
              )
            : handleManagementRequest(admin, request)
    }
    return { admin, database, assertSchema, commit, fetch, modelResolver, platformContext }
}

describe('native named actions in form sessions', () => {
    it.each([
        [{ publication: { slug: 'manual', unknown: 'hidden' } }, 'publication.unknown'],
        [{ sections: [{ text: 'Valid', unknown: 'hidden' }] }, 'sections.0.unknown'],
        [{ matrix: [[{ text: 'Valid', unknown: 'hidden' }]] }, 'matrix.0.0.unknown'],
    ])('rejects nested unknown proposal fields at %s %s before apply or save', async (data, path) => {
        const config = defineSiteAdminConfig({
            models: {
                notes: {
                    fields: {
                        title: text({ required: true }),
                        publication: object({ slug: select(['auto', 'manual']) }),
                        sections: array(object({ text: text() })),
                        matrix: array(array(object({ text: text() }))),
                    },
                },
            },
        })
        const fetch = vi.fn(async () => Response.json({ data }))
        const controller = useSiteAdminForm<Record<string, unknown>>({
            descriptor: createSiteAdminDescriptor(config).models.notes!,
            modelName: 'notes',
            defaultValues: { title: 'Manual' },
            fetch,
        })
        const before = structuredClone(controller.form.state.values)
        await controller.ai.run('prepare', { content: 'Manual' })
        expect(controller.ai.proposal.value?.issues).toEqual([{ path, message: 'Unknown field.' }])
        expect(controller.ai.apply()).toBe(false)
        expect(controller.form.state.values).toEqual(before)
        expect(controller.dirty.value).toBe(false)
        expect(fetch).toHaveBeenCalledOnce()
        expect(controller.entryId.value).toBeNull()
    })

    it.each(['pending', 'proposed'] as const)('rejects changed native props during %s generation', async (when) => {
        const reply = Promise.withResolvers<Response>()
        const props = reactive({ content: 'Before', settings: ['one'] })
        const config = defineSiteAdminConfig({ models: { notes: { fields: { title: text({ required: true }) } } } })
        const admin = createSiteAdmin({ config, database: createMemoryDatabase() })
        const controller = useSiteAdminForm<{ title: string }>({
            descriptor: admin.descriptor.models.notes!,
            modelName: 'notes',
            defaultValues: { title: 'Manual' },
            fetch: async () => reply.promise,
        })
        const generating = controller.ai.run('prepare', props)
        if (when === 'pending') props.settings.push('changed')
        reply.resolve(Response.json({ data: { title: 'Proposed' } }))
        await generating
        if (when === 'proposed') props.settings.push('changed')
        expect(controller.ai.apply()).toBe(false)
        expect(controller.ai.stale.value).toBe(true)
        expect(controller.form.state.values.title).toBe('Manual')
    })
    it('proposes for a new entry through native Output and request context without initializing or saving CMS', async () => {
        const run = vi.fn(async () => generated({ data: { summary: 'Proposed' }, slug: 'chosen' }))
        const { admin, fetch, assertSchema, commit, modelResolver, platformContext } = setup(run)
        const unknown = await fetch('https://site.test/api/site-admin/not-configured', { method: 'POST' })
        expect(unknown.status).toBe(404)
        expect(admin.descriptor).not.toHaveProperty('ai')
        const controller = useSiteAdminForm<{ title: string; summary?: string }>({
            descriptor: admin.descriptor.models.notes!,
            modelName: 'notes',
            defaultValues: { title: 'Manual' },
            origin: 'https://site.test',
            fetch,
        })
        await controller.ai.run('prepare', { content: controller.form.state.values.title })
        expect(controller.ai.error.value).toBeNull()
        expect(controller.entryId.value).toBeNull()
        expect(controller.baseVersion.value).toBeNull()
        expect(assertSchema).not.toHaveBeenCalled()
        expect(commit).not.toHaveBeenCalled()
        expect(controller.form.state.values.summary).toBeUndefined()
        expect(modelResolver).toHaveBeenCalledWith({
            actor: { id: 'admin', roles: ['admin'] },
            request: expect.any(Request),
            platformContext,
        })
        expect(controller.ai.apply()).toBe(true)
        expect(commit).not.toHaveBeenCalled()
        await controller.form.handleSubmit()
        expect(controller.serverError.value).toBeNull()
        expect(commit).toHaveBeenCalledOnce()
        expect((await admin.getEntry(controller.entryId.value!)).data).toEqual({ title: 'Manual', summary: 'Proposed' })
        expect(run).toHaveBeenCalledOnce()
    })

    it('keeps the base version and input when storage changes during native generation; explicit save conflicts', async () => {
        const pending = Promise.withResolvers<Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>>()
        const started = Promise.withResolvers<void>()
        const { admin, fetch } = setup(async () => {
            started.resolve()
            return pending.promise
        })
        const entry = await admin.createEntry('notes', { data: { title: 'Stored' }, slug: '' })
        const controller = useSiteAdminForm<{ title: string; summary?: string }>({
            descriptor: admin.descriptor.models.notes!,
            modelName: 'notes',
            entry,
            origin: 'https://site.test',
            fetch,
        })
        const proposal = controller.ai.run('prepare', { content: 'Unsaved snapshot' })
        await started.promise
        await admin.updateEntry(entry.id, { expectedVersion: entry.version, data: { title: 'Changed elsewhere' } })
        pending.resolve(generated({ data: { summary: 'Proposed' } }))
        await proposal
        expect(controller.ai.apply()).toBe(true)
        await controller.form.handleSubmit()
        expect(controller.serverError.value?.code).toBe('SITE_ADMIN_CONFLICT')
        expect(controller.baseVersion.value).toBe(entry.version)
        expect(controller.form.state.values).toEqual({ title: 'Stored', summary: 'Proposed' })
        expect((await admin.getEntry(entry.id)).data.title).toBe('Changed elsewhere')
    })

    it.each([
        { data: { unknown: 'hidden' } },
        { data: { title: 1 } },
        { data: { title: 'Valid' }, issues: [{ path: 'title', message: 'App policy' }] },
        'plain text',
    ])('rejects invalid or inapplicable proposal %j without saving', async (result) => {
        const fetch = vi.fn(async () => Response.json(result))
        const controller = useSiteAdminForm<{ title: string }>({
            descriptor: {
                fields: { title: { kind: 'text', required: true, serverValidation: false } },
                public: true,
                publishing: true,
                route: false,
                serverValidation: false,
                sortable: false,
            },
            modelName: 'notes',
            defaultValues: { title: 'Manual' },
            fetch,
        })
        await controller.ai.run('prepare', { content: 'Manual' })
        expect(controller.ai.apply()).toBe(false)
        expect(controller.form.state.values.title).toBe('Manual')
        expect(fetch).toHaveBeenCalledOnce()
    })
})
