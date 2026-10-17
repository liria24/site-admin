import type { SiteAdminDatabase as Database } from '../adapter'
import type { Body, Files, StoredFile } from 'files-sdk'

import type { SiteAdminConfig } from '../config'
import type { SiteAdminIssue } from '../errors'
import type { Translations, TranslationInput } from '../i18n'

export interface SiteAdminActor {
    id: string
    roles?: readonly string[]
}

export type FilesResolver = (storage: string) => Promise<Files>

export interface SiteAdminOptions<Context = unknown> {
    presentation?: (locale?: string) => Promise<import('../presentation').PresentationContext>
    authorize?: (request: Request, context?: Context) => Promise<SiteAdminActor | null> | SiteAdminActor | null
    config: SiteAdminConfig
    database: Database
    afterCommit?: (event: import('../config').SiteAdminLifecycleEvent) => Promise<void> | void
    getFiles?: FilesResolver
    id?: () => string
    locales?: {
        defaultLocale?: string
        localizePath?: (path: string, locale: string) => string
        supported?: readonly string[]
    }
    managementBase?: string
    now?: () => Date
    publicBase?: string
    routing?: {
        enabled?: boolean
        preserveHistory?: boolean
        redirects?: boolean
    }
    site?: {
        name?: string
        url?: string
    }
}

export interface EntryInput {
    actorId?: string
    data: Record<string, unknown>
    id?: string
    defaultLocale?: string
    sortOrder?: number | null
    translations?: TranslationInput
}

/** Publishes an existing revision or atomically stores and publishes a caller-owned candidate. */
export type PublishEntryInput<Data = Record<string, unknown>> = {
    actorId?: string
    expectedVersion: number
} & (
    | { revisionId?: string; draft?: never }
    | { draft: { data?: Partial<Data>; translations?: TranslationInput }; revisionId?: never }
)

export interface UpdateEntryInput {
    actorId?: string
    data?: Record<string, unknown>
    translations?: TranslationInput
    expectedVersion: number
}

export interface EntryRecord {
    defaultLocale: string
    translations: Translations
    createdAt: string
    currentRevisionId: string
    data: Record<string, unknown>
    id: string
    locale: string
    model: string
    publishedAt: string | null
    publishedRevisionId: string | null
    revisionId: string
    scheduledAt: string | null
    scheduledRevisionId: string | null
    sortOrder: number | null
    updatedAt: string
    version: number
}

export interface RevisionRecord {
    translations: Translations
    actorId: string | null
    createdAt: string
    data: Record<string, unknown>
    entryId: string
    id: string
}

export interface EntryMutationReceipt {
    id: string
    model: string
    sortOrder: number | null
    version: number
}

export type EntryMutationResult = EntryRecord | EntryMutationReceipt

export interface EntryPage {
    items: EntryRecord[]
    limit: number
    offset: number
    total: number
}

/** JSON-only page metadata. Server configuration and resolver functions never enter this DTO. */
export type PublicEntrySeoValue =
    | boolean
    | number
    | string
    | null
    | PublicEntrySeoValue[]
    | {
          [key: string]: PublicEntrySeoValue
      }

export interface PublicEntrySeoImage {
    component: string
    options?: Record<string, PublicEntrySeoValue> | Array<Record<string, PublicEntrySeoValue>>
    props?: Record<string, PublicEntrySeoValue>
}

export interface PublicEntrySeo {
    alternates?: Array<{ locale: string; path: string }>
    canonical?: string
    description?: string
    /** Omitted inherits the public model image; false disables page image metadata. */
    image?: string | false | PublicEntrySeoImage
    robots?: string
    title?: string
    titleTemplate?: string | null
    twitterCard?: 'summary' | 'summary_large_image'
    type?: 'article' | 'website'
}

export interface PublicEntry<Data = Record<string, unknown>> {
    localeParams?: Record<string, Record<string, string> | false>
    defaultLocale: string
    alternates?: Array<{ locale: string; path: string }>
    data: Data
    id: string
    locale: string
    model: string
    path: string | null
    publishedAt: string
    revisionId: string
    seo?: PublicEntrySeo
}

export interface AssetRecord {
    checksum: string | null
    contentType: string
    createdAt: string
    id: string
    key: string
    leaseExpiresAt: string | null
    metadata: Record<string, string>
    size: number
    state: 'delete_failed' | 'deleted' | 'deleting' | 'ready' | 'upload_failed' | 'uploading'
    storage: string
    operationToken: string | null
    updatedAt: string
}

export interface IncomingReference {
    entryId: string
    field: string
    model: string
    revisionId: string
    view: 'current' | 'published'
}

export interface UploadAssetInput {
    actorId?: string
    body: Body
    contentType?: string
    filename: string
    metadata?: Record<string, string>
    /** Required for streams; checked against the actual byte count. */
    size?: number
}

export interface DownloadedAsset {
    asset: AssetRecord
    file: StoredFile
}

export interface PublishDueResult {
    assets?: AssetSyncResult
    failed: Array<{ entryId: string; message: string }>
    published: string[]
}

export interface AssetSyncResult {
    copied: string[]
    deleted: string[]
    failed: Array<{ id: string; message: string }>
}

export interface SiteAdminDiagnostic {
    code: string
    issues?: SiteAdminIssue[]
    message: string
}

export interface SiteAdminInspection {
    assets: Record<string, number>
    diagnostics: SiteAdminDiagnostic[]
    entries: Record<string, { drafts: number; published: number; scheduled: number; total: number }>
    orphanAssets: number
    publicGeneration: number
}
