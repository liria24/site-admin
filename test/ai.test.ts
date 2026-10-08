import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import {
    createSiteAdminDescriptor,
    defineSiteAdminConfig,
    file,
    markdown,
    number,
    textarea,
    text,
} from '../packages/site-admin/src'
import { createSiteAdminAI } from '../packages/site-admin/src/ai/operations'
import type { SiteAdminAIModelContext } from '../packages/site-admin/src/ai'
import { resolveSiteAdminConfig } from '../packages/site-admin/src/config-resolution'

const definition = {
    displayFields: { title: 'title', description: 'summary' },
    fields: {
        title: text({ required: true }),
        summary: textarea({ maxLength: 180 }),
        body: markdown({ required: true }),
        attachment: file(),
        views: number(),
    },
}

const draft = {
    title: '文章を直す',
    summary: '手動の説明',
    body: '# 記事\n誤字がありまし。\n![写真](site-admin://asset/photo-1)',
    attachment: 'private-file',
    views: 123,
}

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>

const generateResult = (
    value: unknown,
    finish: GenerateResult['finishReason']['unified'] = 'stop',
): GenerateResult => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    finishReason: { unified: finish, raw: undefined },
    usage: {
        inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    warnings: [],
})

const runtime = (value: unknown, finish: GenerateResult['finishReason']['unified'] = 'stop') => {
    const run = vi.fn(async () => generateResult(value, finish))
    const model = new MockLanguageModelV4({ doGenerate: run })
    return { run, model, ai: createSiteAdminAI(model) }
}

describe('generic Site Admin AI operations', () => {
    it('accepts generic model values and resolvers while excluding them from the client descriptor', () => {
        const { model } = runtime({ slug: 'test' })
        const resolver = async (_context: SiteAdminAIModelContext) => model
        const config = defineSiteAdminConfig({
            models: { posts: definition },
            ai: { model },
            $production: { ai: { model: resolver } },
        })
        expect(resolveSiteAdminConfig(config, []).ai.model).toBe(model)
        expect(resolveSiteAdminConfig(config, ['production']).ai.model).toBe(resolver)
        expect(JSON.stringify(createSiteAdminDescriptor(config))).not.toContain('mock-provider')
        expect(createSiteAdminDescriptor(config)).not.toHaveProperty('ai')
    })
    it('uses an application-selected SDK model with SDK-managed structured output', async () => {
        const { ai, run, model } = runtime({ slug: 'edit-japanese-writing', excerpt: '記事の誤字を見直します。' })
        const result = await ai.generateMetadata('posts', definition, {
            data: draft,
            slug: 'manual-slug',
            generate: { slug: true, excerpt: true },
        })
        expect(result).toEqual({
            data: { ...draft, summary: '記事の誤字を見直します。' },
            slug: 'edit-japanese-writing',
            issues: [],
        })
        expect(draft.summary).toBe('手動の説明')
        expect(run).toHaveBeenCalledOnce()
        const inputs = model.doGenerateCalls[0]!
        expect(inputs.responseFormat).toMatchObject({
            type: 'json',
            schema: { type: 'object', additionalProperties: false, required: ['slug', 'excerpt'] },
        })
        expect(JSON.stringify(inputs)).not.toContain('private-file')
        expect(JSON.stringify(inputs)).not.toContain('123')
    })

    it('only regenerates explicitly selected metadata and preserves unchecked fields', async () => {
        const { ai, model } = runtime({ excerpt: '校正に関する記事です。' })
        const result = await ai.generateMetadata('posts', definition, {
            data: draft,
            slug: 'manual-slug',
            generate: { slug: false, excerpt: true },
        })
        expect(result.slug).toBe('manual-slug')
        expect(result.data).toEqual({ ...draft, summary: '校正に関する記事です。' })
        expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({ schema: { required: ['excerpt'] } })

        const slugOnly = runtime({ slug: 'proofread-post' })
        expect(
            await slugOnly.ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).toEqual({ data: draft, slug: 'proofread-post', issues: [] })
    })

    it('does not resolve an AI model when no metadata was selected', async () => {
        const lookup = vi.fn(() => {
            throw new Error('No model should be requested.')
        })
        const ai = createSiteAdminAI(lookup)
        expect(await ai.generateMetadata('posts', definition, { data: draft, generate: {}, slug: 'manual' })).toEqual({
            data: draft,
            slug: 'manual',
            issues: [],
        })
        expect(lookup).not.toHaveBeenCalled()
        const empty = { ...draft, summary: '' }
        expect(
            await ai.generateMetadata('posts', definition, {
                data: empty,
                generate: { slug: false, excerpt: false },
                slug: '',
            }),
        ).toEqual({ data: empty, slug: '', issues: [] })
        expect(lookup).not.toHaveBeenCalled()
    })

    it('returns a proofreading proposal without changing the draft or unrelated fields', async () => {
        const corrected = draft.body.replace('ありまし。', 'あります。')
        const { ai, model } = runtime({ body: corrected })
        const result = await ai.proofreadDraft('posts', definition, { data: draft, fields: ['body'] })
        expect(result).toEqual({ data: { ...draft, body: corrected }, issues: [] })
        expect(draft.body).toContain('ありまし。')
        expect(JSON.stringify(model.doGenerateCalls)).not.toContain('手動の説明')
        expect(JSON.stringify(model.doGenerateCalls)).not.toContain('private-file')
    })

    it('rejects proofreading of asset, relation, or unknown fields before any provider call', async () => {
        const { ai, run } = runtime({})
        for (const name of ['attachment', 'views', 'unknown'])
            await expect(ai.proofreadDraft('posts', definition, { data: draft, fields: [name] })).rejects.toMatchObject(
                {
                    code: 'SITE_ADMIN_INVALID_INPUT',
                },
            )
        expect(run).not.toHaveBeenCalled()
    })

    it('validates metadata mapping and input before any provider call', async () => {
        const { ai, run } = runtime({})
        await expect(
            ai.generateMetadata('posts', { fields: { title: text() } }, { data: {}, generate: { excerpt: true } }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
        await expect(
            ai.generateMetadata('posts', definition, { data: draft, generate: { slug: 'yes' } } as never),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_INVALID_INPUT' })
        expect(run).not.toHaveBeenCalled()
    })

    it.each([
        ['malformed JSON', 'not JSON'],
        ['wrong type', { slug: 7 }],
        ['missing selected field', {}],
        ['extra unchecked field', { slug: 'valid', excerpt: 'unexpected' }],
        ['invalid slug', { slug: 'contains/slash' }],
        ['oversized slug', { slug: 'x'.repeat(81) }],
    ])('rejects %s through SDK output validation without returning a partial proposal', async (_label, output) => {
        const { ai } = runtime(output)
        await expect(
            ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_AI_OUTPUT_INVALID' })
    })

    it('rejects truncated responses and modified Markdown asset references', async () => {
        const truncated = runtime({ slug: 'valid' }, 'length')
        await expect(
            truncated.ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_AI_OUTPUT_INVALID' })
        const changed = runtime({ body: draft.body.replace('photo-1', 'new-photo') })
        await expect(
            changed.ai.proofreadDraft('posts', definition, { data: draft, fields: ['body'] }),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_OUTPUT_INVALID',
        })
    })

    it('reports existing model validation issues without applying unrelated schema transforms', async () => {
        const { ai } = runtime({ slug: 'valid' })
        const result = await ai.generateMetadata('posts', definition, {
            data: { ...draft, views: 'invalid' },
            generate: { slug: true },
        })
        expect(result.data.views).toBe('invalid')
        expect(result.issues).toEqual([{ path: 'views', message: 'Must be a finite number.' }])
        const transformed = {
            ...definition,
            validate: {
                '~standard': {
                    vendor: 'test',
                    version: 1 as const,
                    validate: (value: unknown) => {
                        const data = value as typeof draft
                        data.views = 999
                        return { value: data }
                    },
                },
            },
        }
        const second = await ai.generateMetadata('posts', transformed, { data: draft, generate: { slug: true } })
        expect(second.data).toEqual(draft)
        expect(second.issues).toEqual([])
        expect(draft.views).toBe(123)
    })

    it('rejects refusals and excerpts outside configured descriptor limits', async () => {
        const model = new MockLanguageModelV4({ doGenerate: { ...generateResult(''), content: [] } })
        const ai = createSiteAdminAI(model)
        await expect(
            ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_OUTPUT_INVALID',
        })
        const oversized = runtime({ excerpt: 'x'.repeat(181) })
        await expect(
            oversized.ai.generateMetadata('posts', definition, { data: draft, generate: { excerpt: true } }),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_OUTPUT_INVALID',
        })
    })

    it('defaults proofreading to only populated textual descriptors', async () => {
        const { ai, model } = runtime({ title: draft.title, summary: draft.summary, body: draft.body })
        expect(await ai.proofreadDraft('posts', definition, { data: draft })).toEqual({ data: draft, issues: [] })
        expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({
            schema: { required: ['title', 'summary', 'body'] },
        })
    })

    it('resolves an application model lazily from the current request/task context', async () => {
        const first = runtime({ slug: 'first-model' })
        const second = runtime({ slug: 'second-model' })
        const resolve = vi.fn(async (context: SiteAdminAIModelContext) =>
            context.platformContext === first.model ? first.model : second.model,
        )
        const request = new Request('https://example.test/edit')
        const ai = createSiteAdminAI(resolve, { request, platformContext: first.model })
        const taskAI = createSiteAdminAI(resolve, { platformContext: second.model })
        expect(resolve).not.toHaveBeenCalled()
        expect((await ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } })).slug).toBe(
            'first-model',
        )
        expect(resolve).toHaveBeenNthCalledWith(1, { request, platformContext: first.model })
        expect(
            (await taskAI.generateMetadata('posts', definition, { data: draft, generate: { slug: true } })).slug,
        ).toBe('second-model')
        expect(resolve).toHaveBeenNthCalledWith(2, { platformContext: second.model })
    })

    it('sanitizes provider failures and does not retry paid requests automatically', async () => {
        const run = vi.fn(async () => {
            throw new Error('secret provider token and raw draft')
        })
        const ai = createSiteAdminAI(new MockLanguageModelV4({ doGenerate: run }))
        await expect(
            ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_FAILED',
            message: 'AI could not generate a proposal. Please try again.',
        })
        expect(run).toHaveBeenCalledOnce()
    })

    it('sanitizes application model resolver failures', async () => {
        const resolve = vi.fn(async () => {
            throw new Error('secret binding details')
        })
        const ai = createSiteAdminAI(resolve)
        await expect(
            ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_FAILED',
            message: 'AI could not generate a proposal. Please try again.',
        })
        expect(resolve).toHaveBeenCalledOnce()
    })
})
