import type { SiteAdminDatabase as Database } from '../adapter'
import type { Body, Files, StoredFile } from 'files-sdk'

import type { SiteAdminConfig } from '../config'
import type { SiteAdminAIConfig } from '../ai'
import type { SiteAdminIssue } from '../errors'

export interface SiteAdminActor {
    id: string
    roles?: readonly string[]
}

export type FilesResolver = (storage: string) => Promise<Files>

export interface SiteAdminOptions {
    aiActions?: SiteAdminAIConfig
    aiEnabled?: boolean
    authorize?: (request: Request, context?: unknown) => Promise<SiteAdminActor | null> | SiteAdminActor | null
    config: SiteAdminConfig
    database: Database
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
    locale?: string
    slug?: string
    sortOrder?: number | null
    translationGroup?: string
}

export interface UpdateEntryInput {
    actorId?: string
    data: Record<string, unknown>
    expectedVersion: number
    slug?: string
}

export interface EntryRecord {
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
    slug: string
    sortOrder: number | null
    translationGroup: string
    updatedAt: string
    version: number
}

export interface RevisionRecord {
    actorId: string | null
    createdAt: string
    data: Record<string, unknown>
    entryId: string
    id: string
    slug: string
}

export interface PublicEntry {
    alternates?: Array<{ locale: string; path: string }>
    data: Record<string, unknown>
    id: string
    locale: string
    model: string
    path: string | null
    publishedAt: string
    revisionId: string
    slug: string
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
    failed: Array<{ entryId: string; message: string }>
    published: string[]
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
