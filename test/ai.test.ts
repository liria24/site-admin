import { describe, expect, it, vi } from 'vitest'
import { file, markdown, number, textarea, text } from '../packages/site-admin/src'
import { createWorkersAISiteAdminAI, resolveWorkersAISiteAdminAI } from '../packages/site-admin/src/ai/workers-ai'

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

const chatResponse = (value: unknown, finish = 'stop'): Response =>
    Response.json({
        id: 'chatcmpl-site-admin-test',
        created: 1_790_000_000,
        model: 'gpt-6-luna',
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) },
                finish_reason: finish,
            },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })

const runtime = (value: unknown, finish = 'stop') => {
    const run = vi.fn(async (_model: string, _inputs: Record<string, unknown>, _options?: Record<string, unknown>) =>
        chatResponse(value, finish),
    )
    return {
        run,
        ai: createWorkersAISiteAdminAI({ provider: 'workers-ai', model: 'openai/gpt-6-luna' }, { run }),
    }
}

describe('built-in Site Admin AI operations', () => {
    it('uses the official OpenAI plugin through the native AI binding with SDK-managed structured output', async () => {
        const { ai, run } = runtime({ slug: 'edit-japanese-writing', excerpt: '記事の誤字を見直します。' })
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
        const [model, inputs, options] = run.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
            Record<string, unknown>,
        ]
        expect(model).toBe('openai/gpt-6-luna')
        expect(inputs.response_format).toMatchObject({
            type: 'json_schema',
            json_schema: {
                strict: true,
                schema: { type: 'object', additionalProperties: false, required: ['slug', 'excerpt'] },
            },
        })
        expect(options.returnRawResponse).toBe(true)
        expect(JSON.stringify(inputs)).not.toContain('private-file')
        expect(JSON.stringify(inputs)).not.toContain('123')
    })

    it('only regenerates explicitly selected metadata and preserves unchecked fields', async () => {
        const { ai, run } = runtime({ excerpt: '校正に関する記事です。' })
        const result = await ai.generateMetadata('posts', definition, {
            data: draft,
            slug: 'manual-slug',
            generate: { slug: false, excerpt: true },
        })
        expect(result.slug).toBe('manual-slug')
        expect(result.data).toEqual({ ...draft, summary: '校正に関する記事です。' })
        const inputs = run.mock.calls[0]?.[1] as unknown as {
            response_format: { json_schema: { schema: { required: string[] } } }
        }
        expect(inputs.response_format.json_schema.schema.required).toEqual(['excerpt'])

        const slugOnly = runtime({ slug: 'proofread-post' })
        expect(
            await slugOnly.ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).toEqual({ data: draft, slug: 'proofread-post', issues: [] })
    })

    it('does not touch an AI binding when no metadata was selected', async () => {
        const lookup = vi.fn(() => undefined)
        const ai = createWorkersAISiteAdminAI({ provider: 'workers-ai', model: 'openai/gpt-6-luna' }, lookup)
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
        const { ai, run } = runtime({ body: corrected })
        const result = await ai.proofreadDraft('posts', definition, { data: draft, fields: ['body'] })
        expect(result).toEqual({ data: { ...draft, body: corrected }, issues: [] })
        expect(draft.body).toContain('ありまし。')
        expect(JSON.stringify(run.mock.calls)).not.toContain('手動の説明')
        expect(JSON.stringify(run.mock.calls)).not.toContain('private-file')
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
        const run = vi.fn(async () =>
            Response.json({
                id: 'refusal',
                created: 1,
                model: 'gpt-6-luna',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: null, refusal: 'Cannot answer.' },
                        finish_reason: 'stop',
                    },
                ],
            }),
        )
        const ai = createWorkersAISiteAdminAI({ provider: 'workers-ai', model: 'openai/gpt-6-luna' }, { run })
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
        const { ai, run } = runtime({ title: draft.title, summary: draft.summary, body: draft.body })
        expect(await ai.proofreadDraft('posts', definition, { data: draft })).toEqual({ data: draft, issues: [] })
        const inputs = run.mock.calls[0]?.[1] as unknown as {
            response_format: { json_schema: { schema: { required: string[] } } }
        }
        expect(inputs.response_format.json_schema.schema.required).toEqual(['title', 'summary', 'body'])
    })

    it('resolves a custom binding lazily from Cloudflare context and reports missing bindings', async () => {
        const run = vi.fn(async () => chatResponse({ slug: 'from-binding' }))
        const config = { provider: 'workers-ai' as const, model: 'openai/gpt-6-luna', binding: 'EDITOR_AI' }
        const ai = resolveWorkersAISiteAdminAI(config, { cloudflare: { env: { EDITOR_AI: { run } } } })
        expect(run).not.toHaveBeenCalled()
        expect((await ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } })).slug).toBe(
            'from-binding',
        )
        const missing = resolveWorkersAISiteAdminAI(config, undefined)
        await expect(
            missing.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_UNAVAILABLE',
        })
    })

    it('sanitizes provider failures and does not retry paid requests automatically', async () => {
        const run = vi.fn(async () => {
            throw new Error('secret provider token and raw draft')
        })
        const ai = createWorkersAISiteAdminAI({ provider: 'workers-ai', model: 'openai/gpt-6-luna' }, { run })
        await expect(
            ai.generateMetadata('posts', definition, { data: draft, generate: { slug: true } }),
        ).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_FAILED',
            message: 'AI could not generate a proposal. Please try again.',
        })
        expect(run).toHaveBeenCalledOnce()
    })
})
