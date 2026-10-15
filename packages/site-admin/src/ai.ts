import type { LanguageModel } from 'ai'

export type { SiteAdminAIConfig } from './config'
export { executeSiteAdminAiAction } from './ai/actions-execution'
export type {
    InferSiteAdminNamedAiActions,
    SiteAdminAiActionData,
    SiteAdminAiActionInput,
    SiteAdminNamedAiAction,
    SiteAdminDecisionModel,
} from './ai/actions'

/** Explicit generation context; provider-specific bindings remain application-owned.
 * Nuxt HTTP passes its request context. Applications invoke the native AI SDK directly for background generation.
 */
export interface SiteAdminAIModelContext {
    request?: Request
    platformContext?: object
}

/** An application-selected SDK model, optionally resolved from the current request/task. */
export type SiteAdminAIModel =
    | LanguageModel
    | ((context: SiteAdminAIModelContext) => LanguageModel | Promise<LanguageModel>)
