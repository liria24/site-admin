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
    PublishEntryInput,
    PublishDueResult,
    RevisionRecord,
    SiteAdminInspection,
    UpdateEntryInput,
} from './server/types'
export type { PublicEntry, PublicEntrySeo, PublicEntrySeoImage, PublicEntrySeoValue } from './server/types'
export type { PublicAsset } from './fields'
export type { InferPublicModelData, InferSiteAdminModels, InferSiteAdminPublicModels } from './config'

/** Nuxt augments this with the public and management models inferred from its config. */
export interface SiteAdminClientRegistry {}
export type SiteAdminNamedAiActions = SiteAdminClientRegistry extends { namedAiActions: infer Actions }
    ? Actions
    : Record<string, { props: Record<string, unknown>; data: unknown }>

export type SiteAdminPublicModels = SiteAdminClientRegistry extends { publicModels: infer Models }
    ? Models
    : Record<string, PublicEntry>
export type SiteAdminPublicSummaryModels = SiteAdminClientRegistry extends { publicSummaryModels: infer Models }
    ? Models
    : Record<string, PublicEntry>
export type SiteAdminManagementModels = SiteAdminClientRegistry extends { managementModels: infer Models }
    ? Models
    : Record<string, Record<string, unknown>>
export type SiteAdminFormModels = SiteAdminClientRegistry extends { formModels: infer Models }
    ? Models
    : SiteAdminManagementModels
export { presentSiteAdminData, serializeSiteAdminData, siteAdminAsset } from './management-assets'
export type { SiteAdminAsset } from './management-assets'

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
/** Unsaved form proposal. Applying and saving remain explicit controller actions. */
export interface SiteAdminDraftProposal<Data = Record<string, unknown>> {
    data: Partial<Data>
    issues: SiteAdminIssue[]
    slug?: string
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
    /** Successful entry mutations only. Observer failures cannot turn a saved mutation into a failed request. */
    onMutation?: (mutation: SiteAdminMutation) => Promise<void> | void
}

export interface SiteAdminMutation {
    id: string
    model?: string
    slug?: string
}

export interface SiteAdminRequestOptions {
    signal?: AbortSignal
}

export interface PublicListOptions {
    locale?: string
    signal?: AbortSignal
}

export interface PublicMarkdownListOptions extends PublicListOptions {
    markdown?: 'full' | 'summary'
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
    signal?: AbortSignal
}

export interface SiteAdminVersionInput {
    expectedVersion: number
}

export type SiteAdminPublishInput<Data = Record<string, unknown>> = SiteAdminVersionInput &
    (PublishEntryInput<Data> extends infer Input ? (Input extends object ? Omit<Input, 'actorId'> : never) : never)

export type SiteAdminScheduleInput<Data = Record<string, unknown>> = SiteAdminPublishInput<Data> & { at: string }

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
    readonly searchRemaining?: number

    constructor(code: string, message: string, status: number, issues?: SiteAdminIssue[], searchRemaining?: number) {
        super(message)
        this.name = 'SiteAdminClientError'
        this.code = code
        this.status = status
        if (issues !== undefined) this.issues = issues
        if (searchRemaining !== undefined) this.searchRemaining = searchRemaining
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
            ? (payload.error as { code?: unknown; issues?: unknown; message?: unknown; searchRemaining?: unknown })
            : undefined
    return new SiteAdminClientError(
        String(error?.code ?? 'SITE_ADMIN_REQUEST_FAILED'),
        String(error?.message ?? `Request failed with status ${response.status}.`),
        response.status,
        Array.isArray(error?.issues) ? (error.issues as SiteAdminIssue[]) : undefined,
        typeof error?.searchRemaining === 'number' &&
            Number.isSafeInteger(error.searchRemaining) &&
            error.searchRemaining > 0
            ? error.searchRemaining
            : undefined,
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
    const mutate = <Value>(
        path: string,
        method: string,
        body: unknown,
        requestOptions: SiteAdminRequestOptions = {},
    ): Promise<Value> =>
        json<Value>(path, {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
            method,
            ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
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

export interface SiteAdminClient<Models = SiteAdminPublicModels, SummaryModels = SiteAdminPublicSummaryModels> {
    assetUrl(id: string): string
    get<Name extends ModelName<Models>>(
        model: Name,
        slugOrId: string,
        options?: PublicListOptions,
    ): Promise<Models[Name] | null>
    get<Value>(model: ModelName<Models>, slugOrId: string, options?: PublicListOptions): Promise<Value | null>
    list<Name extends ModelName<Models> & keyof SummaryModels>(
        model: Name,
        options: PublicMarkdownListOptions & { markdown: 'summary' },
    ): Promise<SummaryModels[Name][]>
    list<Name extends ModelName<Models>>(
        model: Name,
        options?: PublicListOptions & { markdown?: 'full' },
    ): Promise<Models[Name][]>
    list<Value>(model: ModelName<Models>, options?: PublicListOptions): Promise<Value[]>
    models(options?: SiteAdminRequestOptions): Promise<SiteAdminDescriptor>
    resolveRoute(path: string, options?: PublicListOptions): Promise<PublicRouteResult | null>
}

export const createSiteAdminClient = <
    Models extends { [Name in keyof Models]: PublicEntry<unknown> } = SiteAdminPublicModels,
    SummaryModels = SiteAdminPublicSummaryModels,
>(
    options: SiteAdminClientOptions = {},
): SiteAdminClient<Models, SummaryModels> => {
    const { base, json } = transport(options, '/api/content')
    return {
        assetUrl: (id) => `${base}/_assets/${encodeURIComponent(id)}`,
        get: (model: ModelName<Models>, slugOrId: string, requestOptions: PublicListOptions = {}) =>
            json<{ data: Record<string, unknown> }>(
                `/${encodeURIComponent(model)}/${encodeURIComponent(slugOrId)}`,
                { method: 'GET', ...(requestOptions.signal ? { signal: requestOptions.signal } : {}) },
                { locale: requestOptions.locale },
                true,
            ).then(entry),
        list: (model: ModelName<Models>, requestOptions?: PublicMarkdownListOptions) => {
            const listOptions = requestOptions ?? {}
            return json<Array<{ data: Record<string, unknown> }>>(
                `/${encodeURIComponent(model)}`,
                { method: 'GET', ...(listOptions.signal ? { signal: listOptions.signal } : {}) },
                {
                    locale: listOptions.locale,
                    ...(listOptions.markdown === 'summary' ? { markdown: 'summary' } : {}),
                },
            ).then((items) => (items ?? []).map((item) => entry(item)!))
        },
        models: (requestOptions = {}) =>
            json<SiteAdminDescriptor>('/models', {
                method: 'GET',
                ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
            }) as Promise<SiteAdminDescriptor>,
        resolveRoute: (path, requestOptions = {}) =>
            json<PublicRouteResult>(
                '/_route',
                { method: 'GET', ...(requestOptions.signal ? { signal: requestOptions.signal } : {}) },
                { locale: requestOptions.locale, path },
                true,
            ),
    } as SiteAdminClient<Models, SummaryModels>
}

export interface SiteAdminManagementClient<Models = SiteAdminManagementModels> {
    assetUrl(id: string): string
    models(options?: SiteAdminRequestOptions): Promise<SiteAdminDescriptor>
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
    getEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        options?: SiteAdminRequestOptions,
    ): Promise<SiteAdminEntry<Data>>
    createEntry<Name extends ModelName<Models>>(
        model: Name,
        input: SiteAdminCreateEntryInput<Models[Name]>,
    ): Promise<SiteAdminEntryMutation<Models[Name]>>
    updateEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: SiteAdminUpdateEntryInput<Data>,
    ): Promise<SiteAdminEntryMutation<Data>>
    deleteEntry(id: string, input: SiteAdminVersionInput): Promise<void>
    publishEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: SiteAdminPublishInput<Data>,
    ): Promise<SiteAdminEntryMutation<Data>>
    unpublishEntry(id: string, input: SiteAdminVersionInput): Promise<SiteAdminEntryMutation<ManagementData<Models>>>
    schedulePublish<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: SiteAdminScheduleInput<Data>,
    ): Promise<SiteAdminEntryMutation<Data>>
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
    runAiAction<Name extends Extract<keyof SiteAdminNamedAiActions, string>>(
        name: Name,
        input: { props: SiteAdminNamedAiActions[Name]['props'] },
        options?: SiteAdminRequestOptions,
    ): Promise<SiteAdminNamedAiActions[Name]['data']>
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
    const get = <Value>(
        path: string,
        query?: Record<string, string | number | undefined>,
        signal?: AbortSignal,
    ): Promise<Value> => json<Value>(path, { method: 'GET', ...(signal ? { signal } : {}) }, query) as Promise<Value>
    const notify = async (mutation: SiteAdminMutation): Promise<void> => {
        try {
            await options.onMutation?.(mutation)
        } catch {
            /* A cache observer cannot undo a committed mutation. */
        }
    }
    const entriesPage = async <Value>(
        query: Record<string, string | number | undefined>,
        signal?: AbortSignal,
    ): Promise<Value> => {
        let previous = Infinity
        while (true) {
            signal?.throwIfAborted()
            try {
                return await get<Value>('/entries', query, signal)
            } catch (error) {
                // Only this resumable search GET may retry. Strictly decreasing positive integers
                // bound further requests by the first remaining count, without a global retry policy.
                if (
                    !query.q ||
                    !(error instanceof SiteAdminClientError) ||
                    error.status !== 503 ||
                    error.code !== 'SITE_ADMIN_SEARCH_PREPARING' ||
                    error.searchRemaining === undefined ||
                    !Number.isSafeInteger(error.searchRemaining) ||
                    error.searchRemaining <= 0 ||
                    error.searchRemaining >= previous
                )
                    throw error
                previous = error.searchRemaining
            }
        }
    }
    const mutateEntry = async <Value extends SiteAdminMutation | SiteAdminMutation[]>(
        path: string,
        method: string,
        body: unknown,
    ): Promise<Value> => {
        const result = await mutate<Value>(path, method, body)
        const mutations: SiteAdminMutation[] = Array.isArray(result) ? result : [result as SiteAdminMutation]
        await Promise.all(mutations.map(notify))
        return result
    }
    return {
        assetUrl: (id) => managementAssetUrl(id, base),
        models: (requestOptions = {}) => get('/models', undefined, requestOptions.signal),
        listEntries: (model: ModelName<Models> | undefined, requestOptions: ManagementListOptions = {}) => {
            const { signal, ...query } = requestOptions
            return entriesPage({ model, ...query }, signal)
        },
        listAllEntries: async (
            model: ModelName<Models> | undefined,
            requestOptions: Omit<ManagementListOptions, 'offset'> = {},
        ) => {
            const { signal, ...query } = requestOptions
            const items: SiteAdminEntry<ManagementData<Models>>[] = []
            let total: number
            do {
                const page = await entriesPage<SiteAdminEntryPage<ManagementData<Models>>>(
                    {
                        model,
                        ...query,
                        limit: requestOptions.limit ?? 100,
                        offset: items.length,
                    },
                    signal,
                )
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
        getEntry: (id, requestOptions = {}) => get(entryPath(id), undefined, requestOptions.signal),
        createEntry: (model, input) => mutateEntry(entryPath(model), 'POST', input),
        updateEntry: (id, input) => mutateEntry(entryPath(id), 'PATCH', input),
        deleteEntry: async (id, input) => {
            const result = await response(entryPath(id), {
                headers: { 'if-match': `"${input.expectedVersion}"` },
                method: 'DELETE',
            })
            const model = result?.headers.get('x-site-admin-model')
            await notify({ id, ...(model ? { model } : {}) })
        },
        publishEntry: (id, input) => mutateEntry(`${entryPath(id)}/publish`, 'POST', input),
        unpublishEntry: (id, input) => mutateEntry(`${entryPath(id)}/unpublish`, 'POST', input),
        schedulePublish: (id, input) => mutateEntry(`${entryPath(id)}/schedule`, 'POST', input),
        cancelScheduledPublish: (id, input) => mutateEntry(`${entryPath(id)}/cancel-schedule`, 'POST', input),
        setSortOrder: (id, sortOrder, expectedVersion) =>
            mutateEntry(`${entryPath(id)}/sort`, 'PATCH', { expectedVersion, sortOrder }),
        setSortOrders: (model, items) => mutateEntry(`${entryPath(model)}/reorder`, 'POST', { items }),
        listRevisions: (id) => get(`${entryPath(id)}/revisions`),
        restoreRevision: (id, revisionId, input) =>
            mutateEntry(`${entryPath(id)}/revisions/${encodeURIComponent(revisionId)}/restore`, 'POST', input),
        pruneRevisions: (id, retain) => mutate(`${entryPath(id)}/revisions/prune`, 'POST', { retain }),
        referencesTo: (id, requestOptions) => get(`${entryPath(id)}/references`, { ...requestOptions }),
        runAiAction: (name, input, requestOptions) =>
            mutate('/ai/actions/' + encodeURIComponent(name), 'POST', input, requestOptions),
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
        publishDue: async () => {
            const result = await mutate<PublishDueResult>('/tasks/publish-due', 'POST', {})
            if (options.onMutation)
                await Promise.all(
                    result.published.map(async (id) => {
                        try {
                            await notify(await get<SiteAdminEntry>(entryPath(id)))
                        } catch {
                            await notify({ id })
                        }
                    }),
                )
            return result
        },
        runAssetGC: () => mutate('/tasks/asset-gc', 'POST', {}),
        inspect: () => get('/diagnostics'),
        routeSnapshot: () => get('/routes'),
    } as SiteAdminManagementClient<Models>
}
