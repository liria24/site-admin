import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { APICallError, Output } from 'ai'
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from 'ai/test'
import { defineSiteAdminConfig } from '../packages/site-admin/src'
import { executeSiteAdminAiAction } from '../packages/site-admin/src/ai'
import { handleAiActionRequest } from '../packages/site-admin/src/server/ai-actions-http'
import { SiteAdminError } from '../packages/site-admin/src/errors'

const result = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
})
const context = {
    actor: { id: 'editor', roles: ['editor'] },
    request: new Request('https://site.test/manage/ai/actions/proofread'),
}
const setup = (generate: MockLanguageModelV4['doGenerate'] = async () => result('{"content":"Corrected"}')) => {
    const run = vi.fn(generate)
    const model = new MockLanguageModelV4({ doGenerate: run })
    const config = defineSiteAdminConfig({
        models: {},
        authorization: { roles: { editor: { ai: ['proofread', 'plain', 'safe'] } } },
        ai: {
            model,
            actions: {
                proofread: {
                    type: 'text-generation',
                    props: { content: z.string(), count: z.string().transform(Number).optional() },
                    prompt: ({ content, count }) => content + (count ?? ''),
                    output: Output.object({ schema: z.object({ content: z.string() }) }),
                },
                plain: { type: 'text-generation', props: { content: z.string() }, prompt: ({ content }) => content },
                safe: {
                    type: 'text-generation',
                    props: { content: z.string(), version: z.number() },
                    prompt: ({ content, version }) => {
                        if (version !== 3) throw new SiteAdminError('SITE_ADMIN_CONFLICT', 'Version changed.')
                        return content
                    },
                    output: ({ content }) =>
                        Output.object({
                            schema: z.object({
                                content: z
                                    .string()
                                    .refine((generated) => generated.includes(content), 'Must preserve input.'),
                            }),
                        }),
                },
            },
        },
    })
    return { config, run }
}

describe('authenticated named native AI actions', () => {
    it('validates and transforms props before resolving the native model, returns native output or text', async () => {
        const { config, run } = setup()
        expect(
            await executeSiteAdminAiAction(config, 'proofread', { props: { content: 'Input', count: '2' } }, context),
        ).toEqual({ content: 'Corrected' })
        expect(run.mock.calls[0]?.[0].prompt).toContainEqual({
            role: 'user',
            content: [{ type: 'text', text: 'Input2' }],
        })
        expect(await executeSiteAdminAiAction(config, 'plain', { props: { content: 'Text' } }, context)).toBe(
            '{"content":"Corrected"}',
        )
    })
    it.each([
        { actor: null, name: 'proofread', props: { content: 'x' }, code: 'SITE_ADMIN_AUTH_REQUIRED' },
        {
            actor: { id: 'user', roles: ['user'] },
            name: 'proofread',
            props: { content: 'x' },
            code: 'SITE_ADMIN_FORBIDDEN',
        },
        { actor: context.actor, name: 'proofread', props: {}, code: 'SITE_ADMIN_INVALID_INPUT' },
        { actor: context.actor, name: 'proofread', props: { content: 4 }, code: 'SITE_ADMIN_INVALID_INPUT' },
        {
            actor: context.actor,
            name: 'proofread',
            props: { content: 'x', model: 'injected' },
            code: 'SITE_ADMIN_INVALID_INPUT',
        },
        { actor: { id: 'admin', roles: ['admin'] }, name: '__proto__', props: {}, code: 'SITE_ADMIN_ENTRY_NOT_FOUND' },
    ])('rejects $code before inference', async ({ actor, name, props, code }) => {
        const { config, run } = setup()
        await expect(executeSiteAdminAiAction(config, name, { props }, { ...context, actor })).rejects.toMatchObject({
            code,
        })
        expect(run).not.toHaveBeenCalled()
    })
    it('keeps native output validation and server version guards application-owned', async () => {
        const { config, run } = setup(async () => result('{"content":"Changed URL"}'))
        await expect(
            executeSiteAdminAiAction(
                config,
                'safe',
                { props: { content: 'https://original.test', version: 2 } },
                context,
            ),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        expect(run).not.toHaveBeenCalled()
        await expect(
            executeSiteAdminAiAction(
                config,
                'safe',
                { props: { content: 'https://original.test', version: 3 } },
                context,
            ),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_AI_FAILED' })
        expect(run).toHaveBeenCalledTimes(1)
    })
    it('snapshots before async validation and forwards native request/platform context', async () => {
        let release!: () => void
        const wait = new Promise<void>((resolve) => {
            release = resolve
        })
        const { run } = setup(async () => result('Text'))
        const resolver = vi.fn(() => new MockLanguageModelV4({ doGenerate: run }))
        const prompt = vi.fn(({ content }: { content: string }) => content)
        const config = defineSiteAdminConfig({
            models: {},
            ai: {
                model: resolver,
                actions: {
                    action: {
                        type: 'text-generation',
                        props: {
                            content: z.string().refine(async () => {
                                await wait
                                return true
                            }),
                        },
                        prompt,
                    },
                },
            },
        })
        const input = { props: { content: 'Original' } }
        const platformContext = { binding: 'App-owned' }
        const pending = executeSiteAdminAiAction(config, 'action', input, {
            ...context,
            actor: { id: 'admin', roles: ['admin'] },
            platformContext,
        })
        input.props.content = 'Changed while validating'
        release()
        expect(await pending).toBe('Text')
        expect(prompt.mock.calls[0]?.[0]).toEqual({ content: 'Original' })
        expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ request: context.request, platformContext }))
    })
    it('uses zero retries by default and redacts provider errors', async () => {
        const { config, run } = setup(async () => {
            throw new APICallError({
                message: 'PRIVATE_KEY_DETAIL',
                url: 'https://private.test',
                requestBodyValues: {},
                isRetryable: true,
            })
        })
        await expect(
            executeSiteAdminAiAction(config, 'plain', { props: { content: 'x' } }, context),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_AI_FAILED', message: 'AI action failed.' })
        expect(run).toHaveBeenCalledTimes(1)
    })
    it('propagates the request abort signal to the native provider', async () => {
        const controller = new AbortController()
        const { config, run } = setup(
            async ({ abortSignal }) =>
                new Promise((_, reject) => {
                    abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
                }),
        )
        const pending = executeSiteAdminAiAction(
            config,
            'plain',
            { props: { content: 'x' } },
            { ...context, request: new Request(context.request, { signal: controller.signal }) },
        )
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
        controller.abort(new DOMException('Cancelled', 'AbortError'))
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(run.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true)
    })
    it('runs a shared or per-action native decision model and keeps named choice answers', async () => {
        const decide = vi.fn<Experimental_DecisionMockModelV4['doDecide']>(async () => ({
            answers: { category: { type: 'choice', choice: 'technology' } },
            warnings: [],
        }))
        const model = new Experimental_DecisionMockModelV4({ doDecide: decide })
        const config = defineSiteAdminConfig({
            models: {},
            ai: {
                decisionModel: model,
                actions: {
                    classify: {
                        type: 'decision',
                        props: { content: z.string() },
                        state: ({ content }) => ({ content }),
                        questions: {
                            category: {
                                type: 'choice',
                                instructions: 'Classify',
                                criteria: { technology: 'Tech', diary: 'Diary' },
                            },
                        },
                    },
                },
            },
        })
        expect(
            await executeSiteAdminAiAction(
                config,
                'classify',
                { props: { content: 'SDK types' } },
                { ...context, actor: { id: 'admin', roles: ['admin'] } },
            ),
        ).toEqual({ category: { type: 'choice', choice: 'technology' } })
        expect(decide.mock.calls[0]?.[0].state).toEqual([{ type: 'json', value: { content: 'SDK types' } }])
    })
    it('protects the HTTP boundary with POST, same origin, private responses and sanitized errors', async () => {
        const { config } = setup()
        const execute = vi.fn((name: string, input: unknown) => executeSiteAdminAiAction(config, name, input, context))
        const req = (headers: Record<string, string> = {}, method = 'POST', body = '{"props":{"content":"x"}}') =>
            new Request('https://site.test/manage/ai/actions/proofread', {
                method,
                headers: { 'content-type': 'application/json', ...headers },
                ...(method === 'POST' ? { body } : {}),
            })
        expect((await handleAiActionRequest(req({}, 'GET'), '/manage', execute)).status).toBe(405)
        expect((await handleAiActionRequest(req({ origin: 'https://other.test' }), '/manage', execute)).status).toBe(
            403,
        )
        expect((await handleAiActionRequest(req({}, 'POST', '{'), '/manage', execute)).status).toBe(400)
        expect(execute).not.toHaveBeenCalled()
        const response = await handleAiActionRequest(req(), '/manage', execute)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(await response.json()).toEqual({ content: 'Corrected' })
        const failed = await handleAiActionRequest(req(), '/manage', async () => {
            throw new Error('PRIVATE_SECRET')
        })
        expect(failed.status).toBe(502)
        expect(await failed.text()).not.toContain('PRIVATE_SECRET')
    })
})
