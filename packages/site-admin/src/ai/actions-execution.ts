import type { SiteAdminConfig } from '../config'
import type { SiteAdminActor } from '../server/types'
import type { SiteAdminAIModelContext } from '../ai'
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
    if (!isObject(input) || !Object.hasOwn(input, 'input'))
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'AI action requires input.')
    const validated = await action.input['~standard'].validate(structuredClone(input.input))
    if (validated.issues)
        throw new SiteAdminError(
            'SITE_ADMIN_INVALID_INPUT',
            'Invalid AI input.',
            validated.issues.map((issue) => ({
                path: [
                    'input',
                    ...(issue.path ?? []).map((part) => String(typeof part === 'object' ? part.key : part)),
                ].join('.'),
                message: issue.message,
            })),
        )
    const values = validated.value
    context.request?.signal.throwIfAborted()
    try {
        if (action.type === 'text-generation') {
            const source = action.model ?? config.ai?.model
            if (!source) throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'A text generation model is required.')
            const model = typeof source === 'function' ? await source(context) : source
            const prompt = await action.prompt(values, context)
            const output = typeof action.output === 'function' ? await action.output(values, context) : action.output
            const completeOutput: typeof output = output && {
                ...output,
                async parseCompleteOutput(value, completion) {
                    if (completion.finishReason !== 'stop')
                        throw new SiteAdminError('SITE_ADMIN_AI_OUTPUT_INVALID', 'AI returned an incomplete result.')
                    return output.parseCompleteOutput(value, completion)
                },
            }
            const signals = [context.request?.signal, action.options?.abortSignal].filter(
                (signal): signal is AbortSignal => !!signal,
            )
            const generated = await generateText({
                maxRetries: 0,
                ...action.options,
                model,
                prompt,
                ...(completeOutput ? { output: completeOutput } : {}),
                ...(signals.length ? { abortSignal: AbortSignal.any(signals) } : {}),
            })
            return generated.output
        }
        const source = action.model ?? config.ai?.decisionModel
        if (!source) throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'A decision model is required.')
        const model = typeof source === 'function' ? await source(context) : source
        const state = await action.state(values, context)
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
