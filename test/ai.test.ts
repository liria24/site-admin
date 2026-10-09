import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { jsonSchema, Output, wrapLanguageModel } from 'ai'
import { createSiteAdminDescriptor, defineSiteAdminConfig, number } from '../packages/site-admin/src'
import { createSiteAdminAI, type SiteAdminAIModelContext } from '../packages/site-admin/src/ai'
import { resolveSiteAdminConfig } from '../packages/site-admin/src/config-resolution'

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>
const result = (value: unknown, finish: GenerateResult['finishReason']['unified'] = 'stop'): GenerateResult => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    finishReason: { unified: finish, raw: undefined },
    usage: {
        inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    warnings: [],
})
const runtime = (value: unknown, finish: GenerateResult['finishReason']['unified'] = 'stop') => {
    const run = vi.fn<MockLanguageModelV4['doGenerate']>(async () => result(value, finish))
    const model = new MockLanguageModelV4({ doGenerate: run })
    return { run, model, ai: createSiteAdminAI(model) }
}
const scoreOutput = () =>
    Output.object({
        schema: jsonSchema<{ score: number }>(
            {
                type: 'object',
                properties: { score: { type: 'number' } },
                required: ['score'],
                additionalProperties: false,
            },
            {
                validate: (value) =>
                    typeof value === 'object' && value !== null && 'score' in value && typeof value.score === 'number'
                        ? { success: true, value: { score: value.score } }
                        : { success: false, error: new Error('App schema rejected score') },
            },
        ),
    })

describe('native application-owned AI execution', () => {
    it('preserves configured native models/resolvers and excludes providers/actions from client descriptors', () => {
        const { model } = runtime({ score: 1 })
        const resolver = async (_context: SiteAdminAIModelContext) => model
        const config = defineSiteAdminConfig({
            models: { inventory: { fields: { quantity: number() } } },
            ai: { model },
            $production: { ai: { model: resolver } },
        })
        expect(resolveSiteAdminConfig(config, []).ai.model).toBe(model)
        expect(resolveSiteAdminConfig(config, ['production']).ai.model).toBe(resolver)
        expect(JSON.stringify(createSiteAdminDescriptor(config))).not.toContain('mock-provider')
        expect(createSiteAdminDescriptor(config)).not.toHaveProperty('ai')
    })
    it('forwards an application prompt and output schema without selecting any CMS fields', async () => {
        const { ai, run } = runtime({ score: 8 })
        const generated = await ai.generateText({
            prompt: 'Classify this inventory.',
            system: 'Application policy.',
            output: scoreOutput(),
            maxRetries: 0,
        })
        const score: number = generated.output.score
        // @ts-expect-error Native output inference remains numeric.
        const wrong: string = generated.output.score
        void wrong
        expect(score).toBe(8)
        const options = run.mock.calls[0]?.[0]
        expect(options?.prompt).toMatchObject([
            { role: 'system', content: 'Application policy.' },
            { role: 'user', content: [{ type: 'text', text: 'Classify this inventory.' }] },
        ])
        expect(options?.responseFormat).toMatchObject({
            type: 'json',
            schema: { properties: { score: { type: 'number' } } },
        })
        expect(ai).not.toHaveProperty('generateMetadata')
        expect(ai).not.toHaveProperty('proofreadDraft')
    })
    it('keeps native plain text and message inputs with no editorial instructions', async () => {
        const { ai, run } = runtime('Native text')
        expect(
            (await ai.generateText({ messages: [{ role: 'user', content: 'Caller message' }], maxRetries: 0 })).text,
        ).toBe('Native text')
        expect(run.mock.calls[0]?.[0].prompt).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'Caller message' }] },
        ])
    })
    it('passes provider options, headers, settings and the native abort signal', async () => {
        const { ai, run } = runtime('Text')
        const abort = new AbortController()
        await ai.generateText({
            prompt: 'Caller',
            providerOptions: { mock: { value: 'native' } },
            headers: { 'x-app': 'header' },
            temperature: 0.2,
            abortSignal: abort.signal,
            maxRetries: 0,
        })
        expect(run.mock.calls[0]?.[0]).toMatchObject({
            providerOptions: { mock: { value: 'native' } },
            headers: { 'x-app': 'header' },
            temperature: 0.2,
        })
        expect(run.mock.calls[0]?.[0].abortSignal).toBe(abort.signal)
    })
    it('uses caller native middleware instead of an SDK-specific adapter', async () => {
        const { model } = runtime('Text')
        const wrapped = vi.fn(async ({ doGenerate }: { doGenerate: () => PromiseLike<GenerateResult> }) => doGenerate())
        const ai = createSiteAdminAI(
            wrapLanguageModel({ model, middleware: { specificationVersion: 'v4', wrapGenerate: wrapped } }),
        )
        expect((await ai.generateText({ prompt: 'Caller', maxRetries: 0 })).text).toBe('Text')
        expect(wrapped).toHaveBeenCalledTimes(1)
    })
    it('leaves finish-reason policy to the application', async () => {
        const { ai } = runtime('Partial', 'length')
        expect((await ai.generateText({ prompt: 'Caller', maxRetries: 0 })).finishReason).toBe('length')
    })
    it.each(['not-json', { score: 'wrong' }])(
        'uses native schema validation and sanitizes invalid output %j',
        async (value) => {
            const { ai } = runtime(value)
            await expect(
                ai.generateText({ prompt: 'Caller', output: scoreOutput(), maxRetries: 0 }),
            ).rejects.toMatchObject({ code: 'SITE_ADMIN_AI_FAILED', message: 'AI operation failed.' })
        },
    )
    it('resolves each request/task binding only when explicitly invoked', async () => {
        const first = runtime('First'),
            second = runtime('Second')
        const request = new Request('https://site.test/action')
        const resolve = vi.fn(async (context: SiteAdminAIModelContext) =>
            context.platformContext === first.model ? first.model : second.model,
        )
        const ai = createSiteAdminAI(resolve, { request, platformContext: first.model })
        const task = createSiteAdminAI(resolve, { platformContext: second.model })
        expect(resolve).not.toHaveBeenCalled()
        expect((await ai.generateText({ prompt: 'Caller', maxRetries: 0 })).text).toBe('First')
        expect((await task.generateText({ prompt: 'Caller', maxRetries: 0 })).text).toBe('Second')
        expect(resolve.mock.calls.map(([context]) => context)).toEqual([
            { request, platformContext: first.model },
            { platformContext: second.model },
        ])
    })
    it('does not cache resolved models across calls', async () => {
        const first = runtime('First'),
            second = runtime('Second')
        const lookup = vi.fn().mockResolvedValueOnce(first.model).mockResolvedValueOnce(second.model)
        const ai = createSiteAdminAI(lookup)
        expect((await ai.generateText({ prompt: 'Caller', maxRetries: 0 })).text).toBe('First')
        expect((await ai.generateText({ prompt: 'Caller', maxRetries: 0 })).text).toBe('Second')
        expect(lookup).toHaveBeenCalledTimes(2)
    })
    it.each(['resolver', 'provider'])('sanitizes %s errors without exposing provider details', async (stage) => {
        const model = new MockLanguageModelV4({
            doGenerate: vi.fn(async () => {
                throw new Error('Secret token and provider 402')
            }),
        })
        const ai = createSiteAdminAI(
            stage === 'resolver'
                ? async () => {
                      throw new Error('Secret binding')
                  }
                : model,
        )
        await expect(ai.generateText({ prompt: 'Caller', maxRetries: 0 })).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_FAILED',
            message: 'AI operation failed.',
        })
    })
    it('reports unavailable request binding only on explicit execution', async () => {
        const lookup = vi.fn(async () => undefined as never)
        const ai = createSiteAdminAI(lookup)
        expect(lookup).not.toHaveBeenCalled()
        await expect(ai.generateText({ prompt: 'Caller' })).rejects.toMatchObject({ code: 'SITE_ADMIN_AI_UNAVAILABLE' })
    })
})
