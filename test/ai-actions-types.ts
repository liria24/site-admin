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
                props: { content: z.string(), tone: z.string().optional() },
                prompt: ({ content, tone }) => content.toUpperCase() + (tone ?? ''),
                output: Output.object({ schema: z.object({ content: z.string() }) }),
            },
            text: { type: 'text-generation', props: { content: z.string() }, prompt: ({ content }) => content },
            guarded: {
                type: 'text-generation',
                props: { count: z.string().transform(Number) },
                prompt: ({ count }) => String(count.toFixed()),
                output: async ({ count }) =>
                    Output.object({ schema: z.object({ count: z.number().refine((value) => value === count) }) }),
            },
            classify: {
                type: 'decision',
                model: decisionModel,
                props: { content: z.string() },
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
const props: Actions['proofread']['props'] = { content: 'Typed' }
const result: Actions['proofread']['data'] = { content: 'Typed' }
const text: Actions['text']['data'] = 'Typed'
const guarded: Actions['guarded']['data'] = { count: 1 }
const guardedProps: Actions['guarded']['props'] = { count: '1' }
// @ts-expect-error schema input differs from validated prompt input
const wrongGuardedProps: Actions['guarded']['props'] = { count: 1 }
const decision: Actions['classify']['data'] = { category: { type: 'choice', choice: 'technology' } }
// @ts-expect-error output remains the native object shape
const wrongOutput: Actions['proofread']['data'] = 'Typed'
// @ts-expect-error native decision choices are preserved
const wrongChoice: Actions['classify']['data'] = { category: { type: 'choice', choice: 'unknown' } }
// @ts-expect-error schema input requires content
const missingProp: Actions['proofread']['props'] = {}
// @ts-expect-error props do not accept an unknown key
const extraProp: Actions['proofread']['props'] = { content: 'Typed', unknown: true }
defineSiteAdminConfig({
    models: {},
    ai: {
        actions: {
            // @ts-expect-error a language model is not a native decision model
            wrong: {
                type: 'decision',
                props: { content: z.string() },
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
                props: { content: z.string() },
                prompt: ({ content }) => content,
                model: decisionModel,
            },
        },
    },
})
void [
    props,
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
