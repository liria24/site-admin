import type { SiteAdminIssue } from './errors'
import type { EntryRecord } from './server/types'

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

export const defineSiteAdminAIConfig = <const Config extends SiteAdminAIConfig>(config: Config): Config => config
