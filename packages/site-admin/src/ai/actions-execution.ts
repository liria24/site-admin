import type { SiteAdminConfig } from '../config'
import type { SiteAdminActor } from '../server/types'
import type { SiteAdminAIModelContext } from '../ai'
import type { SiteAdminIssue } from '../errors'
import { SiteAdminError } from '../errors'
import { generateText, experimental_decide } from 'ai'

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

/** Server-only execution. The actor comes from the application/native session, never request props. */
export const executeSiteAdminAiAction = async (
    config: Pick<SiteAdminConfig, 'ai' | 'authorization'>,
    name: string,
    input: unknown,
    context: SiteAdminAIModelContext & { actor?: SiteAdminActor | null; enabled?: boolean },
): Promise<unknown> => {
    const actor = context.actor
    if (!actor?.id) throw new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'Authentication is required.')
    const permitted =
        actor.roles?.includes('admin') ||
        actor.roles?.some((role) => {
            const actions = config.authorization?.roles[role]?.ai
            return actions?.includes(name) || actions?.includes('*')
        })
    if (!permitted) throw new SiteAdminError('SITE_ADMIN_FORBIDDEN', 'This role cannot execute that AI action.')
    if (context.enabled === false) throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'AI actions are disabled.')
    const actions = config.ai?.actions
    const action = actions && Object.hasOwn(actions, name) ? actions[name] : undefined
    if (!action) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', 'AI action does not exist.')
    if (!isObject(input) || !isObject(input.props))
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'AI action requires a props object.')
    const values = structuredClone(input.props)
    const issues: SiteAdminIssue[] = []
    const props: Record<string, unknown> = {}
    for (const key of Object.keys(values))
        if (!Object.hasOwn(action.props, key)) issues.push({ path: `props.${key}`, message: 'Unknown property.' })
    for (const [key, schema] of Object.entries(action.props)) {
        const result = await schema['~standard'].validate(values[key])
        if (result.issues) {
            issues.push(
                ...result.issues.map((issue) => ({
                    path: [
                        'props',
                        key,
                        ...(issue.path?.map((part) => String(typeof part === 'object' ? part.key : part)) ?? []),
                    ].join('.'),
                    message: issue.message,
                })),
            )
        } else props[key] = result.value
    }
    if (issues.length) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Invalid AI action props.', issues)
    context.request?.signal.throwIfAborted()
    try {
        if (action.type === 'text-generation') {
            const source = action.model ?? config.ai?.model
            if (!source) throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'A text generation model is required.')
            const model = typeof source === 'function' ? await source(context) : source
            const prompt = await action.prompt(props, context)
            const output = typeof action.output === 'function' ? await action.output(props, context) : action.output
            const signals = [context.request?.signal, action.options?.abortSignal].filter(
                (signal): signal is AbortSignal => !!signal,
            )
            const generated = await generateText({
                maxRetries: 0,
                ...action.options,
                model,
                prompt,
                ...(output ? { output } : {}),
                ...(signals.length ? { abortSignal: AbortSignal.any(signals) } : {}),
            })
            return generated.output
        }
        const source = action.model ?? config.ai?.decisionModel
        if (!source) throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'A decision model is required.')
        const model = typeof source === 'function' ? await source(context) : source
        const state = await action.state(props, context)
        const signals = [context.request?.signal, action.options?.abortSignal].filter(
            (signal): signal is AbortSignal => !!signal,
        )
        const result = await experimental_decide({
            maxRetries: 0,
            ...action.options,
            model,
            state,
            questions: action.questions,
            ...(signals.length ? { abortSignal: AbortSignal.any(signals) } : {}),
        })
        return result.answers
    } catch (error) {
        if (error instanceof SiteAdminError) throw error
        if (context.request?.signal.aborted) throw context.request.signal.reason
        throw new SiteAdminError('SITE_ADMIN_AI_FAILED', 'AI action failed.')
    }
}
