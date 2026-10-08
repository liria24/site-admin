import type {
    SiteAdminAIDraftProposal,
    SiteAdminAIProposal,
    SiteAdminMetadataInput,
    SiteAdminProofreadInput,
} from './ai'
import type { SiteAdminDescriptor } from './descriptor'
import type { SiteAdminIssue } from './errors'
import type {
    AssetRecord,
    EntryInput,
    EntryMutationReceipt,
    EntryPage,
    EntryRecord,
    IncomingReference,
    PublicEntry,
    PublishDueResult,
    RevisionRecord,
    SiteAdminInspection,
    UpdateEntryInput,
} from './server/types'
export type { PublicEntry } from './server/types'
export type { PublicAsset } from './fields'
export type { InferPublicModelData, InferSiteAdminModels, InferSiteAdminPublicModels } from './config'

/** Nuxt augments this with the public and management models inferred from its config. */
export interface SiteAdminClientRegistry {}

export type SiteAdminPublicModels = SiteAdminClientRegistry extends { publicModels: infer Models }
    ? Models
    : Record<string, PublicEntry>
export type SiteAdminManagementModels = SiteAdminClientRegistry extends { managementModels: infer Models }
    ? Models
    : Record<string, Record<string, unknown>>

type ModelName<Models> = Extract<keyof Models, string>
type ManagementData<Models> = Models[keyof Models]
export type SiteAdminEntry<Data = Record<string, unknown>> = Omit<EntryRecord, 'data'> & { data: Data }
export type SiteAdminRevision<Data = Record<string, unknown>> = Omit<RevisionRecord, 'data'> & { data: Data }
export type SiteAdminEntryMutation<Data = Record<string, unknown>> = SiteAdminEntry<Data> | EntryMutationReceipt
export type SiteAdminEntryPage<Data = Record<string, unknown>> = Omit<EntryPage, 'items'> & {
    items: SiteAdminEntry<Data>[]
}
export type SiteAdminCreateEntryInput<Data = Record<string, unknown>> = Omit<EntryInput, 'actorId' | 'data'> & {
    data: Data
}
export type SiteAdminUpdateEntryInput<Data = Record<string, unknown>> = Omit<UpdateEntryInput, 'actorId' | 'data'> & {
    data: Data
}
export type SiteAdminMetadataDraftInput<Data = Record<string, unknown>> = Omit<SiteAdminMetadataInput, 'data'> & {
    data: Partial<Data>
}
export type SiteAdminProofreadDraftInput<Data = Record<string, unknown>> = Omit<
    SiteAdminProofreadInput,
    'data' | 'fields'
> & {
    data: Partial<Data>
    fields?: readonly Extract<keyof Data, string>[]
}
export type SiteAdminDraftProposal<Data = Record<string, unknown>> = Omit<SiteAdminAIDraftProposal, 'data'> & {
    data: Partial<Data>
}

export const managementAssetUrl = (id: string, base = '/api/site-admin'): string =>
    `${base.replace(/\/$/u, '')}/assets/${encodeURIComponent(id)}/content`

export interface SiteAdminClientOptions {
    basePath?: string
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    origin?: string
}

export interface SiteAdminManagementClientOptions extends SiteAdminClientOptions {
    credentials?: RequestCredentials
}

export interface PublicListOptions {
    locale?: string
}

export interface PublicRouteResult {
    entry?: Record<string, unknown>
    kind: 'page' | 'redirect'
    status?: number
    target?: string
}

export interface ManagementListOptions {
    limit?: number
    locale?: string
    offset?: number
    q?: string
}

export interface SiteAdminVersionInput {
    expectedVersion: number
}

export interface SiteAdminPublishInput extends SiteAdminVersionInput {
    revisionId?: string
}

export interface SiteAdminScheduleInput extends SiteAdminPublishInput {
    at: string
}

export interface SiteAdminSortInput extends SiteAdminVersionInput {
    id: string
    sortOrder: number | null
}

export interface SiteAdminReferencesOptions {
    field?: string
    from?: string
    view: 'current' | 'published'
}

export interface SiteAdminAssetUploadOptions {
    contentType?: string
    filename: string
}

export interface SiteAdminRouteRecord {
    entryId: string
    kind: 'historical' | 'page' | 'redirect'
    locale: string
    path: string
    status: number | null
    targetPath: string | null
}

export interface SiteAdminAssetGCResult {
    deleted: string[]
    failed: Array<{ id: string; message: string }>
}

export class SiteAdminClientError extends Error {
    readonly code: string
    readonly issues?: SiteAdminIssue[]
    readonly status: number

    constructor(code: string, message: string, status: number, issues?: SiteAdminIssue[]) {
        super(message)
        this.name = 'SiteAdminClientError'
        this.code = code
        this.status = status
        if (issues !== undefined) this.issues = issues
    }
}

const normalizeBase = (origin: string, basePath: string): string =>
    `${origin.replace(/\/$/u, '')}/${basePath.split('/').filter(Boolean).join('/')}`

const responseError = async (response: Response): Promise<SiteAdminClientError> => {
    const payload: unknown = await response.json().catch(() => null)
    const error =
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'object' &&
        payload.error !== null
            ? (payload.error as { code?: unknown; issues?: unknown; message?: unknown })
            : undefined
    return new SiteAdminClientError(
        String(error?.code ?? 'SITE_ADMIN_REQUEST_FAILED'),
        String(error?.message ?? `Request failed with status ${response.status}.`),
        response.status,
        Array.isArray(error?.issues) ? (error.issues as SiteAdminIssue[]) : undefined,
    )
}

const transport = (options: SiteAdminClientOptions, defaultBase: string, credentials?: RequestCredentials) => {
    const request = options.fetch ?? globalThis.fetch
    const base = normalizeBase(options.origin ?? '', options.basePath ?? defaultBase)
    const urlFor = (path: string, query?: Record<string, string | number | undefined>): string => {
        const url = new URL(`${base}${path}`, options.origin || globalThis.location?.origin || 'http://localhost')
        for (const [name, value] of Object.entries(query ?? {}))
            if (value !== undefined) url.searchParams.set(name, String(value))
        return options.origin ? url.href : `${url.pathname}${url.search}`
    }
    const response = async (
        path: string,
        init: RequestInit = {},
        query?: Record<string, string | number | undefined>,
        nullable = false,
    ): Promise<Response | null> => {
        const result = await request(urlFor(path, query), {
            ...(credentials === undefined ? {} : { credentials }),
            ...init,
        })
        if (nullable && result.status === 404) return null
        if (!result.ok) throw await responseError(result)
        return result
    }
    const json = async <Value>(
        path: string,
        init?: RequestInit,
        query?: Record<string, string | number | undefined>,
        nullable = false,
    ): Promise<Value | null> => {
        const result = await response(path, init, query, nullable)
        if (!result || result.status === 204) return null
        return (await result.json()) as Value
    }
    const mutate = <Value>(path: string, method: string, body: unknown): Promise<Value> =>
        json<Value>(path, {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
            method,
        }) as Promise<Value>
    return { base, json, mutate, response }
}

const entry = <Value>(document: { data: Record<string, unknown> } | null): Value | null => {
    if (!document) return null
    const { _siteAdmin, ...data } = document.data
    if (!_siteAdmin || typeof _siteAdmin !== 'object') {
        throw new SiteAdminClientError('SITE_ADMIN_INVALID_RESPONSE', 'Public entry metadata is missing.', 502)
    }
    return { ..._siteAdmin, data } as Value
}

export interface SiteAdminClient<Models = SiteAdminPublicModels> {
    assetUrl(id: string): string
    get<Name extends ModelName<Models>>(
        model: Name,
        slugOrId: string,
        options?: PublicListOptions,
    ): Promise<Models[Name] | null>
    get<Value>(model: ModelName<Models>, slugOrId: string, options?: PublicListOptions): Promise<Value | null>
    list<Name extends ModelName<Models>>(model: Name, options?: PublicListOptions): Promise<Models[Name][]>
    list<Value>(model: ModelName<Models>, options?: PublicListOptions): Promise<Value[]>
    models(): Promise<SiteAdminDescriptor>
    resolveRoute(path: string, options?: PublicListOptions): Promise<PublicRouteResult | null>
}

export const createSiteAdminClient = <
    Models extends { [Name in keyof Models]: PublicEntry<unknown> } = SiteAdminPublicModels,
>(
    options: SiteAdminClientOptions = {},
): SiteAdminClient<Models> => {
    const { base, json } = transport(options, '/api/content')
    return {
        assetUrl: (id) => `${base}/_assets/${encodeURIComponent(id)}`,
        get: (model: ModelName<Models>, slugOrId: string, requestOptions: PublicListOptions = {}) =>
            json<{ data: Record<string, unknown> }>(
                `/${encodeURIComponent(model)}/${encodeURIComponent(slugOrId)}`,
                { method: 'GET' },
                { locale: requestOptions.locale },
                true,
            ).then(entry),
        list: (model: ModelName<Models>, requestOptions: PublicListOptions = {}) =>
            json<Array<{ data: Record<string, unknown> }>>(
                `/${encodeURIComponent(model)}`,
                { method: 'GET' },
                { locale: requestOptions.locale },
            ).then((items) => (items ?? []).map((item) => entry(item)!)),
        models: () => json<SiteAdminDescriptor>('/models', { method: 'GET' }) as Promise<SiteAdminDescriptor>,
        resolveRoute: (path, requestOptions = {}) =>
            json<PublicRouteResult>('/_route', { method: 'GET' }, { locale: requestOptions.locale, path }, true),
    } as SiteAdminClient<Models>
}

export interface SiteAdminManagementClient<Models = SiteAdminManagementModels> {
    assetUrl(id: string): string
    models(): Promise<SiteAdminDescriptor>
    listEntries<Name extends ModelName<Models>>(
        model: Name,
        options?: ManagementListOptions,
    ): Promise<SiteAdminEntryPage<Models[Name]>>
    listEntries(model?: undefined, options?: ManagementListOptions): Promise<SiteAdminEntryPage<ManagementData<Models>>>
    listAllEntries<Name extends ModelName<Models>>(
        model: Name,
        options?: Omit<ManagementListOptions, 'offset'>,
    ): Promise<SiteAdminEntry<Models[Name]>[]>
    listAllEntries(
        model?: undefined,
        options?: Omit<ManagementListOptions, 'offset'>,
    ): Promise<SiteAdminEntry<ManagementData<Models>>[]>
    getEntry<Data extends ManagementData<Models> = ManagementData<Models>>(id: string): Promise<SiteAdminEntry<Data>>
    createEntry<Name extends ModelName<Models>>(
        model: Name,
        input: SiteAdminCreateEntryInput<Models[Name]>,
    ): Promise<SiteAdminEntryMutation<Models[Name]>>
    updateEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: SiteAdminUpdateEntryInput<Data>,
    ): Promise<SiteAdminEntryMutation<Data>>
    deleteEntry(id: string, input: SiteAdminVersionInput): Promise<void>
    publishEntry(id: string, input: SiteAdminPublishInput): Promise<SiteAdminEntryMutation<ManagementData<Models>>>
    unpublishEntry(id: string, input: SiteAdminVersionInput): Promise<SiteAdminEntryMutation<ManagementData<Models>>>
    schedulePublish(id: string, input: SiteAdminScheduleInput): Promise<SiteAdminEntryMutation<ManagementData<Models>>>
    cancelScheduledPublish(
        id: string,
        input: SiteAdminVersionInput,
    ): Promise<SiteAdminEntryMutation<ManagementData<Models>>>
    setSortOrder(
        id: string,
        sortOrder: number | null,
        expectedVersion: number,
    ): Promise<SiteAdminEntryMutation<ManagementData<Models>>>
    setSortOrders<Name extends ModelName<Models>>(
        model: Name,
        items: SiteAdminSortInput[],
    ): Promise<SiteAdminEntryMutation<Models[Name]>[]>
    listRevisions<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
    ): Promise<SiteAdminRevision<Data>[]>
    restoreRevision(
        id: string,
        revisionId: string,
        input: SiteAdminVersionInput,
    ): Promise<SiteAdminEntryMutation<ManagementData<Models>>>
    pruneRevisions(id: string, retain: number): Promise<{ deleted: string[] }>
    referencesTo(id: string, options: SiteAdminReferencesOptions): Promise<IncomingReference[]>
    generateMetadata<Name extends ModelName<Models>>(
        model: Name,
        input: SiteAdminMetadataDraftInput<Models[Name]>,
    ): Promise<SiteAdminDraftProposal<Models[Name]>>
    proofreadDraft<Name extends ModelName<Models>>(
        model: Name,
        input: SiteAdminProofreadDraftInput<Models[Name]>,
    ): Promise<SiteAdminDraftProposal<Models[Name]>>
    runAIAction(id: string, action: string, input: Record<string, unknown>): Promise<SiteAdminAIProposal>
    uploadAsset(file: File): Promise<AssetRecord>
    uploadAsset(body: Blob, options: SiteAdminAssetUploadOptions): Promise<AssetRecord>
    getAsset(id: string): Promise<AssetRecord>
    downloadAsset(id: string): Promise<Response>
    deleteAsset(id: string): Promise<void>
    publishDue(): Promise<PublishDueResult>
    runAssetGC(): Promise<SiteAdminAssetGCResult>
    inspect(): Promise<SiteAdminInspection>
    routeSnapshot(): Promise<SiteAdminRouteRecord[]>
}

/** Uses the existing authenticated, same-origin management HTTP API. */
export const createSiteAdminManagementClient = <
    Models extends { [Name in keyof Models]: Record<string, unknown> } = SiteAdminManagementModels,
>(
    options: SiteAdminManagementClientOptions = {},
): SiteAdminManagementClient<Models> => {
    const { base, json, mutate, response } = transport(options, '/api/site-admin', options.credentials ?? 'same-origin')
    const entryPath = (id: string): string => `/entries/${encodeURIComponent(id)}`
    const assetPath = (id: string): string => `/assets/${encodeURIComponent(id)}`
    const get = <Value>(path: string, query?: Record<string, string | number | undefined>): Promise<Value> =>
        json<Value>(path, { method: 'GET' }, query) as Promise<Value>
    return {
        assetUrl: (id) => managementAssetUrl(id, base),
        models: () => get('/models'),
        listEntries: (model: ModelName<Models> | undefined, requestOptions: ManagementListOptions = {}) =>
            get('/entries', { model, ...requestOptions }),
        listAllEntries: async (
            model: ModelName<Models> | undefined,
            requestOptions: Omit<ManagementListOptions, 'offset'> = {},
        ) => {
            const items: SiteAdminEntry<ManagementData<Models>>[] = []
            let total: number
            do {
                const page = await get<SiteAdminEntryPage<ManagementData<Models>>>('/entries', {
                    model,
                    ...requestOptions,
                    limit: requestOptions.limit ?? 100,
                    offset: items.length,
                })
                items.push(...page.items)
                total = page.total
                if (page.items.length === 0 && items.length < total) {
                    throw new SiteAdminClientError(
                        'SITE_ADMIN_INVALID_RESPONSE',
                        'Entry list changed. Reload latest.',
                        502,
                    )
                }
            } while (items.length < total)
            return items
        },
        getEntry: (id) => get(entryPath(id)),
        createEntry: (model, input) => mutate(entryPath(model), 'POST', input),
        updateEntry: (id, input) => mutate(entryPath(id), 'PATCH', input),
        deleteEntry: async (id, input) => {
            await response(entryPath(id), { headers: { 'if-match': `"${input.expectedVersion}"` }, method: 'DELETE' })
        },
        publishEntry: (id, input) => mutate(`${entryPath(id)}/publish`, 'POST', input),
        unpublishEntry: (id, input) => mutate(`${entryPath(id)}/unpublish`, 'POST', input),
        schedulePublish: (id, input) => mutate(`${entryPath(id)}/schedule`, 'POST', input),
        cancelScheduledPublish: (id, input) => mutate(`${entryPath(id)}/cancel-schedule`, 'POST', input),
        setSortOrder: (id, sortOrder, expectedVersion) =>
            mutate(`${entryPath(id)}/sort`, 'PATCH', { expectedVersion, sortOrder }),
        setSortOrders: (model, items) => mutate(`${entryPath(model)}/reorder`, 'POST', { items }),
        listRevisions: (id) => get(`${entryPath(id)}/revisions`),
        restoreRevision: (id, revisionId, input) =>
            mutate(`${entryPath(id)}/revisions/${encodeURIComponent(revisionId)}/restore`, 'POST', input),
        pruneRevisions: (id, retain) => mutate(`${entryPath(id)}/revisions/prune`, 'POST', { retain }),
        referencesTo: (id, requestOptions) => get(`${entryPath(id)}/references`, { ...requestOptions }),
        generateMetadata: (model, input) => mutate(`/models/${encodeURIComponent(model)}/ai/metadata`, 'POST', input),
        proofreadDraft: (model, input) => mutate(`/models/${encodeURIComponent(model)}/ai/proofread`, 'POST', input),
        runAIAction: (id, action, input) => mutate(`${entryPath(id)}/ai/${encodeURIComponent(action)}`, 'POST', input),
        uploadAsset: async (body, uploadOptions) => {
            const filename = uploadOptions?.filename ?? ('name' in body ? String(body.name) : undefined)
            if (!filename) throw new TypeError('A filename is required to upload an asset.')
            const headers = new Headers({
                'x-filename': encodeURIComponent(filename),
                'x-upload-size': String(body.size),
            })
            const contentType = uploadOptions?.contentType ?? body.type
            if (contentType) headers.set('content-type', contentType)
            return (await json<AssetRecord>('/assets', { body, headers, method: 'POST' }))!
        },
        getAsset: (id) => get(assetPath(id)),
        downloadAsset: (id) => response(`${assetPath(id)}/content`, { method: 'GET' }) as Promise<Response>,
        deleteAsset: async (id) => {
            await response(assetPath(id), { method: 'DELETE' })
        },
        publishDue: () => mutate('/tasks/publish-due', 'POST', {}),
        runAssetGC: () => mutate('/tasks/asset-gc', 'POST', {}),
        inspect: () => get('/diagnostics'),
        routeSnapshot: () => get('/routes'),
    } as SiteAdminManagementClient<Models>
}
