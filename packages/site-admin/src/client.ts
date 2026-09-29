import type { SiteAdminDescriptor } from './descriptor'

export interface SiteAdminClientOptions {
    basePath?: string
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    origin?: string
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

export class SiteAdminClientError extends Error {
    readonly code: string
    readonly status: number

    constructor(code: string, message: string, status: number) {
        super(message)
        this.name = 'SiteAdminClientError'
        this.code = code
        this.status = status
    }
}

const normalizeBase = (origin: string, basePath: string): string =>
    `${origin.replace(/\/$/u, '')}/${basePath.split('/').filter(Boolean).join('/')}`

const entry = <Value>(document: { data: Record<string, unknown> } | null): Value | null => {
    if (!document) return null
    const { _siteAdmin, ...data } = document.data
    if (!_siteAdmin || typeof _siteAdmin !== 'object') {
        throw new SiteAdminClientError('SITE_ADMIN_INVALID_RESPONSE', 'Public entry metadata is missing.', 502)
    }
    return { ..._siteAdmin, data } as Value
}

export const createSiteAdminClient = (options: SiteAdminClientOptions = {}) => {
    const request = options.fetch ?? globalThis.fetch
    const base = normalizeBase(options.origin ?? '', options.basePath ?? '/api/content')
    const get = async <Value>(
        path: string,
        query?: Record<string, string | undefined>,
        nullable = false,
    ): Promise<Value | null> => {
        const url = new URL(`${base}${path}`, options.origin || globalThis.location?.origin || 'http://localhost')
        for (const [name, value] of Object.entries(query ?? {}))
            if (value !== undefined) url.searchParams.set(name, value)
        const response = await request(options.origin ? url.href : `${url.pathname}${url.search}`, { method: 'GET' })
        const payload: unknown = await response.json().catch(() => null)
        if (nullable && response.status === 404) return null
        if (!response.ok) {
            const error =
                typeof payload === 'object' && payload && 'error' in payload && typeof payload.error === 'object'
                    ? (payload.error as { code?: unknown; message?: unknown })
                    : undefined
            throw new SiteAdminClientError(
                String(error?.code ?? 'SITE_ADMIN_REQUEST_FAILED'),
                String(error?.message ?? `Request failed with status ${response.status}.`),
                response.status,
            )
        }
        return payload as Value
    }
    return {
        assetUrl: (id: string): string => `${base}/_assets/${encodeURIComponent(id)}`,
        get: <Value = Record<string, unknown>>(
            model: string,
            slugOrId: string,
            requestOptions: PublicListOptions = {},
        ) =>
            get<{ data: Record<string, unknown> }>(
                `/${encodeURIComponent(model)}/${encodeURIComponent(slugOrId)}`,
                { locale: requestOptions.locale },
                true,
            ).then(entry<Value>),
        list: <Value = Record<string, unknown>>(model: string, requestOptions: PublicListOptions = {}) =>
            get<Array<{ data: Record<string, unknown> }>>(`/${encodeURIComponent(model)}`, {
                locale: requestOptions.locale,
            }).then((items) => (items ?? []).map((item) => entry<Value>(item)!)),
        models: () => get<SiteAdminDescriptor>('/models') as Promise<SiteAdminDescriptor>,
        resolveRoute: (path: string, requestOptions: PublicListOptions = {}) =>
            get<PublicRouteResult>('/_route', { locale: requestOptions.locale, path }, true),
    }
}

export type SiteAdminClient = ReturnType<typeof createSiteAdminClient>
