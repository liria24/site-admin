import type { AssetRecord, EntryRecord, IncomingReference, RevisionRecord } from './server/types'
import { SiteAdminError } from './errors'

export const searchQueryLimit = 512
export const searchQuery = (
    value: string | undefined,
    lowercase: (text: string) => string = (text) => text.toLocaleLowerCase(),
): string | undefined => {
    const validate = (text: string) => {
        let count = 0
        for (const codePoint of text) {
            void codePoint
            if (++count > searchQueryLimit)
                throw new SiteAdminError(
                    'SITE_ADMIN_INVALID_INPUT',
                    `Search query exceeds ${searchQueryLimit} code points.`,
                )
        }
        return text
    }
    return value === undefined ? undefined : validate(lowercase(validate(value)))
}

/** Storage data uses domain names and values, never SQL, ORM columns or encoded JSON. */
export type StorageEntryState = Omit<EntryRecord, 'data' | 'revisionId' | 'slug'>
export type StorageEntryPatch = Partial<
    Pick<
        StorageEntryState,
        | 'currentRevisionId'
        | 'publishedRevisionId'
        | 'scheduledRevisionId'
        | 'scheduledAt'
        | 'publishedAt'
        | 'sortOrder'
        | 'updatedAt'
    >
>
export interface StoragePublishedEntry {
    data: Record<string, unknown>
    id: string
    locale: string
    model: string
    publishedAt: string
    revisionId: string
    slug: string
    translationGroup: string
}
export interface StorageRoute {
    entryId: string
    revisionId: string | null
    kind: 'historical' | 'page' | 'redirect'
    locale: string
    path: string
    status: number | null
    targetPath: string | null
    createdAt: string
}
export type StorageCondition =
    | { kind: 'entryVersion'; id: string; version: number; model?: string }
    | { kind: 'assetsReady'; ids: readonly string[] }
    | { kind: 'relations'; targets: readonly { id: string; model: string; published: boolean }[] }
    | { kind: 'noRequiredPublicReferences'; id: string; models: readonly string[] }
    | { kind: 'noRetainedRelations'; id: string }
export type StorageRouteChange =
    | { kind: 'remove'; entryId: string; kinds?: readonly StorageRoute['kind'][]; path?: string }
    | { kind: 'retargetHistory'; entryId: string; path: string | null; status: number }
    | { kind: 'put'; route: StorageRoute }
export interface StorageRevisionCandidate extends RevisionRecord {
    model: string
    assets: readonly { id: string; path: string; position: number }[]
    relations: readonly { id: string; path: string; position: number; required: boolean }[]
}

/** All conditions are evaluated against the same pre-commit state. No partial effects on conflict. */
export interface StorageContentCommit {
    conditions?: readonly StorageCondition[]
    create?: StorageEntryState
    revisions?: readonly StorageRevisionCandidate[]
    routes?: readonly StorageRouteChange[]
    updates?: readonly { id: string; patch: StorageEntryPatch }[]
    delete?: string
    publicGeneration?: boolean
}
export interface StorageEntryFilter {
    /** An empty set means no authorized models, not all models. */
    models?: readonly string[]
    locale?: string
    q?: string
}
export interface StorageContent {
    readEntry(id: string): Promise<EntryRecord | undefined>
    entries(filter?: StorageEntryFilter): Promise<EntryRecord[]>
    /** Filters apply before paging and count. Implementations must not fetch all data then slice. */
    pageEntries(
        filter: StorageEntryFilter,
        page: { limit: number; offset: number },
    ): Promise<{ items: EntryRecord[]; total: number }>
    readRevision(id: string, entryId?: string): Promise<RevisionRecord | undefined>
    revisions(entryId: string): Promise<RevisionRecord[]>
    revisionIds(entryId: string): Promise<string[]>
    pruneRevisions(entryId: string, candidates: readonly string[]): Promise<string[]>
    referenceTargets(
        ids: readonly string[],
    ): Promise<Array<{ id: string; model: string; publishedRevisionId: string | null }>>
    incomingReferences(
        id: string,
        options: {
            view: 'current' | 'published'
            from?: string
            field?: string
            required?: boolean
            excludeSelf?: boolean
        },
    ): Promise<IncomingReference[]>
    hasRetainedRelations(id: string): Promise<boolean>
    published(filter?: {
        model?: string
        ids?: readonly string[]
        locale?: string
        translationGroups?: readonly string[]
        key?: string
    }): Promise<StoragePublishedEntry[]>
    routes(filter?: {
        entryId?: string
        kinds?: readonly StorageRoute['kind'][]
        locales?: readonly string[]
        path?: string
    }): Promise<StorageRoute[]>
    scheduledBefore(now: string): Promise<Array<{ id: string; revisionId: string; version: number }>>
    publicGeneration(): Promise<number>
    commit(input: StorageContentCommit): Promise<void>
}

export interface StorageAssetCopy {
    assetId: string
    key: string
    state: 'copying' | 'ready' | 'retired'
    storage: string
}
export interface StorageAssetSyncLease {
    id: string
    expiresAt: string
}
export interface StorageAssetCopyGuard {
    lease: StorageAssetSyncLease
    now: string
    generation?: number
}
export interface StorageAssets {
    readAsset(id: string): Promise<AssetRecord | undefined>
    assets(filter?: { ids?: readonly string[]; state?: AssetRecord['state']; storage?: string }): Promise<AssetRecord[]>
    assetGCCandidates(cutoff: string, now: string): Promise<AssetRecord[]>
    hasAssetReferences(id: string): Promise<boolean>
    publishedAssetSources(id: string): Promise<string[]>
    insertAsset(asset: AssetRecord): Promise<void>
    finishAssetUpload(
        id: string,
        token: string,
        ready: { contentType: string; size: number; checksum: string } | undefined,
        now: string,
    ): Promise<boolean>
    claimAssetDeletion(id: string, token: string, leaseExpiresAt: string, now: string): Promise<boolean>
    finishAssetDeletion(id: string, token: string, success: boolean, now: string): Promise<boolean>
    assetStorageMode(): Promise<{ separate: false } | { separate: true; storage: string } | undefined>
    bindAssetStorageMode(storage: string): Promise<void>
    hasLegacyAssetOriginals(): Promise<boolean>
    assetCopies(): Promise<Array<{ ledger: string; copy: StorageAssetCopy }>>
    claimAssetSync(lease: StorageAssetSyncLease, now: string): Promise<boolean>
    releaseAssetSync(lease: StorageAssetSyncLease): Promise<void>
    createAssetCopy(ledger: string, copy: StorageAssetCopy, guard: StorageAssetCopyGuard): Promise<boolean>
    updateAssetCopy(ledger: string, copy: StorageAssetCopy, guard?: StorageAssetCopyGuard): Promise<boolean>
    statistics(): Promise<{
        entries: Array<{ total: number; drafts: number; model: string; published: number; scheduled: number }>
        assets: Array<{ count: number; state: string }>
        orphanAssets: number
    }>
}
