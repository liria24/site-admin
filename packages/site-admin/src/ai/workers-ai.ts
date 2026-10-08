import { createWorkersAI } from 'workers-ai-provider'
import { openai } from 'workers-ai-provider/openai'
import type { SiteAdminAIRuntime, SiteAdminWorkersAIConfig } from '../ai'
import { SiteAdminError } from '../errors'
import { createSiteAdminAI } from './operations'

const bindingFromContext = (context: object | undefined, name: string): unknown => {
    const cloudflare = context && 'cloudflare' in context ? context.cloudflare : undefined
    const env = cloudflare && typeof cloudflare === 'object' && 'env' in cloudflare ? cloudflare.env : undefined
    return env && typeof env === 'object' ? (env as Record<string, unknown>)[name] : undefined
}

/** Resolves only the current request/task binding. It never uses API keys or a remote REST fallback. */
export const createWorkersAISiteAdminAI = (
    config: SiteAdminWorkersAIConfig,
    binding: unknown | (() => unknown),
): SiteAdminAIRuntime =>
    createSiteAdminAI(() => {
        if (config.provider !== 'workers-ai' || typeof config.model !== 'string' || !config.model.trim())
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Workers AI requires a model identifier.')
        const current = typeof binding === 'function' ? binding() : binding
        if (!current || typeof current !== 'object' || !('run' in current) || typeof current.run !== 'function')
            throw new SiteAdminError(
                'SITE_ADMIN_AI_UNAVAILABLE',
                `Workers AI binding "${config.binding ?? 'AI'}" is missing from the current request or task context.`,
            )
        // Partner models need the provider's OpenAI-wire plugin for SDK-managed
        // Chat Completions structured output; the stock @cf adapter uses native wire format.
        const workersai = createWorkersAI({
            binding: current as NonNullable<Parameters<typeof createWorkersAI>[0]['binding']>,
            ...(config.model.startsWith('@') ? {} : { providers: [openai], resume: false }),
        })
        return workersai(config.model)
    })

/** Binding lookup stays lazy so an AI setting never blocks ordinary CRUD without Cloudflare AI. */
export const resolveWorkersAISiteAdminAI = (
    config: SiteAdminWorkersAIConfig,
    context: object | undefined | (() => object | undefined),
): SiteAdminAIRuntime =>
    createWorkersAISiteAdminAI(config, () =>
        bindingFromContext(typeof context === 'function' ? context() : context, config.binding ?? 'AI'),
    )
