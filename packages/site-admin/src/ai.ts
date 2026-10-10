import type { LanguageModel, Output, ToolSet, generateText } from 'ai'

export type { SiteAdminAIConfig } from './config'
export { createSiteAdminAI } from './ai/operations'
export { executeSiteAdminAiAction } from './ai/actions-execution'
export type {
    InferSiteAdminNamedAiActions,
    SiteAdminAiActionData,
    SiteAdminAiActionProps,
    SiteAdminNamedAiAction,
    SiteAdminDecisionModel,
} from './ai/actions'

/** Explicit generation context; provider-specific bindings remain application-owned.
 * Nuxt HTTP passes its request context. Background AI uses createSiteAdminAI(model, context).
 */
export interface SiteAdminAIModelContext {
    request?: Request
    platformContext?: object
}

/** An application-selected SDK model, optionally resolved from the current request/task. */
export type SiteAdminAIModel =
    | LanguageModel
    | ((context: SiteAdminAIModelContext) => LanguageModel | Promise<LanguageModel>)

type NativeContext = NonNullable<Parameters<typeof generateText>[0]['runtimeContext']>
type WithoutModel<Options> = Options extends unknown ? Omit<Options, 'model'> : never
export type SiteAdminAIExecution = <
    Tools extends ToolSet,
    Context extends NativeContext = NativeContext,
    Result extends Output.Output = Output.Output<string, string>,
>(
    options: WithoutModel<Parameters<typeof generateText<Tools, Context, Result>>[0]>,
) => ReturnType<typeof generateText<Tools, Context, Result>>
