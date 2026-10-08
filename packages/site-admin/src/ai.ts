import type { SiteAdminIssue } from './errors'
import type { EntryRecord } from './server/types'
import type { ModelDefinition } from './config'

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

export interface SiteAdminAIConfig {
    models: Record<string, Record<string, SiteAdminAIAction>>
}

export interface SiteAdminAIProposal extends SiteAdminAIActionResult {
    baseRevisionId: string
    issues: SiteAdminIssue[]
    slug: string
    version: number
}

/** Selects the built-in, server-only Workers AI implementation. */
export interface SiteAdminWorkersAIConfig {
    provider: 'workers-ai'
    model: string
    /** Name of the binding in the current Cloudflare environment. Defaults to `AI`. */
    binding?: string
}

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
