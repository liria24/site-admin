import { generateText } from 'ai'
import type { Output, ToolSet } from 'ai'
import type { SiteAdminAIExecution, SiteAdminAIModel, SiteAdminAIModelContext } from '../ai'
import { SiteAdminError } from '../errors'

type NativeContext = NonNullable<Parameters<typeof generateText>[0]['runtimeContext']>
type NativeOptions<Tools extends ToolSet, Context extends NativeContext, Result extends Output.Output> = Parameters<
    typeof generateText<Tools, Context, Result>
>[0]
type WithoutModel<Options> = Options extends unknown ? Omit<Options, 'model'> : never

/** Resolves an application-selected model and forwards native AI SDK options unchanged. No prompts or output schemas. */
export const createSiteAdminAI = (
    model: SiteAdminAIModel,
    context: SiteAdminAIModelContext = {},
): { generateText: SiteAdminAIExecution } => {
    const run = async <
        Tools extends ToolSet,
        Context extends NativeContext = NativeContext,
        Result extends Output.Output = Output.Output<string, string>,
    >(
        options: WithoutModel<NativeOptions<Tools, Context, Result>>,
    ): Promise<Awaited<ReturnType<typeof generateText<Tools, Context, Result>>>> => {
        try {
            const resolved = await (typeof model === 'function' ? model(context) : model)
            if (!resolved)
                throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'An AI model is not available for this request.')
            // Omit distributes across the SDK prompt/tool-context unions; the configured model completes those native options.
            return await generateText<Tools, Context, Result>({ ...options, model: resolved } as NativeOptions<
                Tools,
                Context,
                Result
            >)
        } catch (error) {
            if (error instanceof SiteAdminError) throw error
            throw new SiteAdminError('SITE_ADMIN_AI_FAILED', 'AI operation failed.')
        }
    }
    return { generateText: run }
}
