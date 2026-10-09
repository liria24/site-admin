import { MockLanguageModelV4 } from 'ai/test'
export let aiCalls = 0
export const aiModel = new MockLanguageModelV4({
    doGenerate: async () => {
        aiCalls++
        return {
            content: [{ type: 'text', text: '{"content":"Corrected"}' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
        }
    },
})
