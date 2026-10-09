import type { SiteAdminIssue } from './errors'
import type { EntryRecord } from './server/types'
import type { ModelDefinition } from './config'
import type { LanguageModel } from 'ai'

export interface SiteAdminAIActionInput {
    entry: EntryRecord
    input: Record<string, unknown>
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

export interface SiteAdminMetadataInput {
    data: Record<string, unknown>
    generate: { slug?: boolean; excerpt?: boolean }
    slug?: string
}

export interface SiteAdminProofreadInput {
    data: Record<string, unknown>
    /** Top-level text, textarea, or markdown fields. Defaults to populated textual fields. */
    fields?: readonly string[]
}

/** Unsaved proposal. Applying it and saving remain explicit caller actions. */
export interface SiteAdminAIDraftProposal {
    data: Record<string, unknown>
    issues: SiteAdminIssue[]
    slug?: string
}

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
