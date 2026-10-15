import { z } from 'zod'
import { Output } from 'ai'
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from 'ai/test'
import { defineSiteAdminConfig, type InferSiteAdminNamedAiActions } from '../packages/site-admin/src'

const model = new MockLanguageModelV4()
const decisionModel = new Experimental_DecisionMockModelV4()
const config = defineSiteAdminConfig({
    models: {},
    ai: {
        model,
        decisionModel,
        actions: {
            proofread: {
                type: 'text-generation',
                model,
                input: z.object({ content: z.string(), tone: z.string().optional() }).strict(),
                prompt: ({ content, tone }) => content.toUpperCase() + (tone ?? ''),
                output: Output.object({ schema: z.object({ content: z.string() }) }),
            },
            text: {
                type: 'text-generation',
                input: z.object({ content: z.string() }).strict(),
                prompt: ({ content }) => content,
            },
            guarded: {
                type: 'text-generation',
                input: z.object({ count: z.string().transform(Number) }).strict(),
                prompt: ({ count }) => String(count.toFixed()),
                output: async ({ count }) =>
                    Output.object({ schema: z.object({ count: z.number().refine((value) => value === count) }) }),
            },
            classify: {
                type: 'decision',
                model: decisionModel,
                input: z.object({ content: z.string() }).strict(),
                state: ({ content }) => ({ content }),
                questions: {
                    category: {
                        type: 'choice',
                        instructions: 'Classify',
                        criteria: { technology: 'Technology', diary: 'Diary' },
                    },
                },
            },
        },
    },
})
type Actions = InferSiteAdminNamedAiActions<typeof config>
const input: Actions['proofread']['input'] = { content: 'Typed' }
const result: Actions['proofread']['data'] = { content: 'Typed' }
const text: Actions['text']['data'] = 'Typed'
const guarded: Actions['guarded']['data'] = { count: 1 }
const guardedProps: Actions['guarded']['input'] = { count: '1' }
// @ts-expect-error schema input differs from validated prompt input
const wrongGuardedProps: Actions['guarded']['input'] = { count: 1 }
const decision: Actions['classify']['data'] = { category: { type: 'choice', choice: 'technology' } }
// @ts-expect-error output remains the native object shape
const wrongOutput: Actions['proofread']['data'] = 'Typed'
// @ts-expect-error native decision choices are preserved
const wrongChoice: Actions['classify']['data'] = { category: { type: 'choice', choice: 'unknown' } }
// @ts-expect-error schema input requires content
const missingProp: Actions['proofread']['input'] = {}
// @ts-expect-error input do not accept an unknown key
const extraProp: Actions['proofread']['input'] = { content: 'Typed', unknown: true }
defineSiteAdminConfig({
    models: {},
    ai: {
        actions: {
            // @ts-expect-error a language model is not a native decision model
            wrong: {
                type: 'decision',
                input: z.object({ content: z.string() }).strict(),
                state: ({ content }) => ({ content }),
                questions: {},
                model,
            },
        },
    },
})
defineSiteAdminConfig({
    models: {},
    ai: {
        actions: {
            // @ts-expect-error a decision model cannot generate text
            wrong: {
                type: 'text-generation',
                input: z.object({ content: z.string() }).strict(),
                prompt: ({ content }) => content,
                model: decisionModel,
            },
        },
    },
})
void [
    input,
    result,
    text,
    guarded,
    guardedProps,
    wrongGuardedProps,
    decision,
    wrongOutput,
    wrongChoice,
    missingProp,
    extraProp,
]
