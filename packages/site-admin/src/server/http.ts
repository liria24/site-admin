import { SiteAdminError } from '../errors'
import { createManagementOperations } from './operations'
import { projectMarkdownListSummary } from '../markdown/list-summary'
import type { SiteAdmin } from './site-admin'

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response => {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify(value), { ...init, headers })
}

const errorResponse = (error: unknown): Response => {
    if (error instanceof SiteAdminError) {
        return jsonResponse(
            {
                error: {
                    code: error.code,
                    ...(error.issues ? { issues: error.issues } : {}),
                    ...(error.committed ? { committed: true, receipt: error.receipt, effects: error.effects } : {}),
                    message: error.message,
                },
            },
            { status: error.status },
        )
    }
    return jsonResponse(
        { error: { code: 'SITE_ADMIN_INTERNAL_ERROR', message: 'Internal Site Admin error.' } },
        { status: 500 },
    )
}

const pathAfter = (request: Request, base: string): string[] => {
    const pathname = new URL(request.url).pathname
    const normalized = base.replace(/\/$/u, '')
    if (pathname !== normalized && !pathname.startsWith(`${normalized}/`)) return []
    return pathname.slice(normalized.length).split('/').filter(Boolean).map(decodeURIComponent)
}

const bodyObject = async (request: Request): Promise<Record<string, unknown>> => {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Content-Type must be application/json.')
    }
    let value: unknown
    try {
        value = await request.json()
    } catch {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Request body must be valid JSON.')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'JSON request body must be an object.')
    }
    return value as Record<string, unknown>
}

const requiredString = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `"${name}" must be a non-empty string.`)
    }
    return value
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const inlineTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])

const assetResponse = (
    request: Request,
    asset: Awaited<ReturnType<SiteAdmin['getAsset']>>,
    file: Awaited<ReturnType<SiteAdmin['downloadAsset']>>['file'],
    management: boolean,
): Response => {
    const etag = `"sha256-${asset.checksum ?? asset.id}"`
    const headers = new Headers({
        'cache-control': management ? 'private, no-store' : 'public, no-cache',
        'content-length': String(asset.size),
        'content-type': asset.contentType,
        etag,
        'x-content-type-options': 'nosniff',
    })
    if (!inlineTypes.has(asset.contentType)) {
        headers.set('content-disposition', `attachment; filename="${asset.key.split('/').at(-1) ?? 'download'}"`)
        headers.set('content-security-policy', "sandbox; default-src 'none'")
    }
    if (!management && request.headers.get('if-none-match') === etag)
        return new Response(null, { headers, status: 304 })
    return new Response(request.method === 'HEAD' ? null : file.stream(), { headers })
}

const handleManagementRequestInner = async <Context>(
    siteAdmin: SiteAdmin<Context>,
    request: Request,
    base = '/api/site-admin',
    context?: Context,
): Promise<Response> => {
    try {
        const path = pathAfter(request, base),
            method = request.method.toUpperCase()
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            const origin = request.headers.get('origin'),
                site = request.headers.get('sec-fetch-site')
            if (origin !== null ? origin !== new URL(request.url).origin : site !== null && site !== 'same-origin')
                throw new SiteAdminError('SITE_ADMIN_FORBIDDEN', 'Management mutations require the same origin.')
        }
        const api = createManagementOperations<Context, Record<string, Record<string, unknown>>>(
            () => siteAdmin,
            request,
            context,
        )
        await api.authorize()
        const json = jsonResponse
        if (method === 'GET' && path.length === 1) {
            if (path[0] === 'models') return json(await api.models())
            if (path[0] === 'diagnostics') return json(await api.inspect())
            if (path[0] === 'routes') return json(await api.routeSnapshot())
            if (path[0] === 'entries') {
                const query = new URL(request.url).searchParams
                return json(
                    await api.listEntries((query.get('model') ?? undefined) as never, {
                        limit: Number(query.get('limit') ?? 50),
                        offset: Number(query.get('offset') ?? 0),
                        ...(query.has('locale') ? { locale: query.get('locale')! } : {}),
                        ...(query.has('q') ? { q: query.get('q')! } : {}),
                    }),
                )
            }
        }
        if (method === 'POST' && path[0] === 'entries' && path.length === 2)
            return json(await api.createEntry(path[1]!, (await bodyObject(request)) as never), { status: 201 })
        if (method === 'POST' && path[0] === 'entries' && path[2] === 'reorder' && path.length === 3) {
            const body = await bodyObject(request)
            return json(await api.setSortOrders(path[1]!, body.items as never))
        }
        if (path[0] === 'entries' && path[1]) {
            const id = path[1]
            if (method === 'GET' && path.length === 2) return json(await api.getEntry(id))
            if (method === 'GET' && path[2] === 'revisions' && path.length === 3)
                return json(await api.listRevisions(id))
            if (method === 'GET' && path[2] === 'references' && path.length === 3) {
                const query = new URL(request.url).searchParams
                return json(
                    await api.referencesTo(id, {
                        view: query.get('view') as 'current' | 'published',
                        ...(query.has('from') ? { from: query.get('from')! } : {}),
                        ...(query.has('field') ? { field: query.get('field')! } : {}),
                    }),
                )
            }
            if (method === 'PATCH' && path.length === 2)
                return json(await api.updateEntry(id, (await bodyObject(request)) as never))
            if (method === 'DELETE' && path.length === 2) {
                const match = request.headers.get('if-match')
                const body =
                    match === null
                        ? await bodyObject(request)
                        : { expectedVersion: /^"\d+"$/u.test(match) ? Number(match.slice(1, -1)) : NaN }
                await api.deleteEntry(id, body as never)
                return new Response(null, { status: 204 })
            }
            if (method === 'POST') {
                const body = await bodyObject(request)
                if (path[2] === 'publish') return json(await api.publishEntry(id, body as never))
                if (path[2] === 'unpublish') return json(await api.unpublishEntry(id, body as never))
                if (path[2] === 'schedule') return json(await api.schedulePublish(id, body as never))
                if (path[2] === 'cancel-schedule') return json(await api.cancelScheduledPublish(id, body as never))
                if (path[2] === 'revisions' && path[4] === 'restore')
                    return json(await api.restoreRevision(id, path[3]!, body as never))
                if (path[2] === 'revisions' && path[3] === 'prune')
                    return json(await api.pruneRevisions(id, body.retain as number))
            }
            if (method === 'PATCH' && path[2] === 'sort') {
                const body = await bodyObject(request)
                return json(await api.setSortOrder(id, body.sortOrder as number | null, body.expectedVersion as number))
            }
        }
        if (method === 'POST' && path.length === 1 && path[0] === 'assets') {
            const contentType = request.headers.get('content-type') ?? undefined
            if (contentType?.startsWith('multipart/form-data') || !request.body)
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Send the raw upload body.')
            const size = request.headers.get('x-upload-size')
            if (!size || !/^[1-9]\d*$/u.test(size))
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'x-upload-size must be a positive byte count.')
            let filename: string
            try {
                filename = decodeURIComponent(requiredString(request.headers.get('x-filename'), 'x-filename'))
            } catch {
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'x-filename must be URL encoded.')
            }
            return json(
                await api.upload({
                    body: request.body,
                    filename,
                    size: Number(size),
                    ...(contentType ? { contentType } : {}),
                }),
                { status: 201 },
            )
        }
        if (path[0] === 'assets' && path[1]) {
            if (method === 'GET' && path.length === 2) return json(await api.getAsset(path[1]))
            if (method === 'GET' && path[2] === 'content' && path.length === 3) {
                await api.getAsset(path[1])
                const { asset, file } = await siteAdmin.downloadAsset(path[1], false)
                return assetResponse(request, asset, file, true)
            }
            if (method === 'DELETE' && path.length === 2) {
                await api.deleteAsset(path[1])
                return new Response(null, { status: 204 })
            }
        }
        if (method === 'POST' && path[0] === 'tasks') {
            if (path[1] === 'publish-due') return json(await api.publishDue())
            if (path[1] === 'asset-gc') return json(await api.runAssetGC())
        }
        return json(
            { error: { code: 'SITE_ADMIN_NOT_FOUND', message: 'Management route not found.' } },
            { status: 404 },
        )
    } catch (error) {
        return errorResponse(error)
    }
}

export const handleManagementRequest = async <Context>(
    siteAdmin: SiteAdmin<Context>,
    request: Request,
    base = '/api/site-admin',
    context?: Context,
): Promise<Response> => {
    const response = await handleManagementRequestInner(siteAdmin, request, base, context)
    response.headers.set('cache-control', 'private, no-store')
    response.headers.set('x-content-type-options', 'nosniff')
    return response
}

const publicDescriptor = <Context>(siteAdmin: SiteAdmin<Context>): unknown => {
    const descriptor = siteAdmin.descriptor
    descriptor.models = Object.fromEntries(Object.entries(descriptor.models).filter(([, model]) => model.public))
    return descriptor
}

export const handlePublicRequest = async <Context>(
    siteAdmin: SiteAdmin<Context>,
    request: Request,
    base = '/api/content',
): Promise<Response> => {
    let response: Response
    try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response = jsonResponse(
                { error: { code: 'SITE_ADMIN_METHOD_NOT_ALLOWED', message: 'Method not allowed.' } },
                { status: 405 },
            )
        } else {
            const url = new URL(request.url)
            const locale = url.searchParams.get('locale') ?? undefined
            const path = pathAfter(request, base)
            if (path.length === 1 && path[0] === 'models') response = jsonResponse(publicDescriptor(siteAdmin))
            else if (path.length === 1 && path[0] === '_sitemap') response = jsonResponse(await siteAdmin.sitemap())
            else if (path.length === 1 && path[0] === '_route') {
                const route = new URL(request.url).searchParams.get('path')
                if (!route) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Query parameter "path" is required.')
                const result = await siteAdmin.resolvePath(route, locale)
                response = result ? jsonResponse(result) : jsonResponse(null, { status: 404 })
            } else if (path[0] === '_assets' && path[1]) {
                const { asset, file } = await siteAdmin.downloadAsset(path[1], true)
                response = assetResponse(request, asset, file, false)
            } else {
                const modelName = optionalString(path[0])
                if (!modelName) {
                    response = jsonResponse({
                        models: Object.keys((publicDescriptor(siteAdmin) as { models: object }).models),
                    })
                } else {
                    if (path.length === 1) {
                        const mode = url.searchParams.get('markdown') ?? 'full'
                        if (mode !== 'full' && mode !== 'summary')
                            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Unknown Markdown list mode.')
                        const limit = url.searchParams.get('limit'),
                            offset = url.searchParams.get('offset')
                        if (limit !== null || offset !== null) {
                            const page = { limit: Number(limit ?? 20), offset: Number(offset ?? 0) }
                            if (
                                !Number.isSafeInteger(page.limit) ||
                                page.limit < 1 ||
                                page.limit > 100 ||
                                !Number.isSafeInteger(page.offset) ||
                                page.offset < 0
                            )
                                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Invalid public page.')
                            const result = await siteAdmin.contentPage(modelName, page, locale)
                            response = jsonResponse({
                                ...result,
                                items:
                                    mode === 'summary'
                                        ? await projectMarkdownListSummary(
                                              result.items,
                                              modelName,
                                              siteAdmin.config,
                                              (id) => base.replace(/\/$/u, '') + '/_assets/' + encodeURIComponent(id),
                                          )
                                        : result.items,
                            })
                        } else {
                            const generation = await siteAdmin.publicGeneration()
                            const items = await siteAdmin.contentList(modelName, locale)
                            if (generation !== (await siteAdmin.publicGeneration()))
                                throw new SiteAdminError(
                                    'SITE_ADMIN_CONFLICT',
                                    'Publication changed during listing; refresh.',
                                )
                            response = jsonResponse(
                                mode === 'summary'
                                    ? await projectMarkdownListSummary(
                                          items,
                                          modelName,
                                          siteAdmin.config,
                                          (id) => `${base.replace(/\/$/u, '')}/_assets/${encodeURIComponent(id)}`,
                                      )
                                    : items,
                            )
                        }
                    } else {
                        const key = path.slice(1).join('/')
                        const item = await siteAdmin.contentDocument(modelName, key, locale)
                        response = item ? jsonResponse(item) : jsonResponse(null, { status: 404 })
                    }
                }
            }
        }
    } catch (error) {
        response = errorResponse(error)
    }
    response.headers.set('access-control-allow-methods', 'GET, HEAD')
    response.headers.set('access-control-allow-origin', '*')
    response.headers.append('vary', 'origin')
    if (request.method === 'HEAD') return new Response(null, response)
    return response
}
