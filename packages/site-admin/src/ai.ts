import type { SiteAdminIssue } from './errors'
import type { EntryRecord } from './server/types'
import type { ModelDefinition } from './config'
import type { LanguageModel, Output, ToolSet, generateText } from 'ai'

export interface SiteAdminAIActionInput {
    entry: EntryRecord
    input: Record<string, unknown>
    /** Native request/task context, for application-owned SDK model and prompt selection. */
    context?: SiteAdminAIModelContext
    /** Model-bound native AI SDK call. Prompts, outputs and provider options belong to this action. */
    ai?: SiteAdminAIExecution
}

export interface SiteAdminAIActionResult {
    data: Record<string, unknown>
    issues?: SiteAdminIssue[]
    slug?: string
}

export type SiteAdminAIAction = (
    input: SiteAdminAIActionInput,
) => Promise<SiteAdminAIActionResult> | SiteAdminAIActionResult

export interface SiteAdminAIActionConfig {
    models: Record<string, Record<string, SiteAdminAIAction>>
}

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

export interface SiteAdminAIProposal extends SiteAdminAIActionResult {
    baseRevisionId: string
    issues: SiteAdminIssue[]
    slug: string
    version: number
}

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

export interface SiteAdminMetadataInput {
    data: Record<string, unknown>
    generate: { slug?: boolean; excerpt?: boolean }
    slug?: string
}

export interface SiteAdminProofreadInput {
    data: Record<string, unknown>
    /** Legacy application callback input. The SDK does not select fields or supply an editing policy. */
    fields?: readonly string[]
}

/** Unsaved proposal. Applying it and saving remain explicit caller actions. */
export interface SiteAdminAIDraftProposal {
    data: Record<string, unknown>
    issues: SiteAdminIssue[]
    slug?: string
}

/** @deprecated Optional application-owned legacy callbacks. No SDK generation policies are supplied. */
export interface SiteAdminAIRuntime {
    generateMetadata(
        model: string,
        definition: ModelDefinition,
        input: SiteAdminMetadataInput,
        slugMaxLength?: number,
    ): Promise<SiteAdminAIDraftProposal>
    proofreadDraft(
        model: string,
        definition: ModelDefinition,
        input: SiteAdminProofreadInput,
    ): Promise<SiteAdminAIDraftProposal>
}
