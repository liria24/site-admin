import { SiteAdminError } from '../errors'
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

const expectedVersion = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"expectedVersion" must be a non-negative integer.')
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

const handleManagementRequestInner = async (
    siteAdmin: SiteAdmin,
    request: Request,
    base = '/api/site-admin',
    context?: unknown,
): Promise<Response> => {
    let redactError = false
    try {
        const actor = await siteAdmin.authorizeRequest(request, context)
        const entryResult = (value: unknown): unknown => {
            if (!value || typeof value !== 'object' || !('currentRevisionId' in value)) return value
            const entry = value as Awaited<ReturnType<SiteAdmin['getEntry']>>
            return siteAdmin.can(actor, 'model', 'readDraft', entry.model)
                ? entry
                : { id: entry.id, model: entry.model, sortOrder: entry.sortOrder, version: entry.version }
        }
        const json = (value: unknown, init?: ResponseInit): Response =>
            jsonResponse(Array.isArray(value) ? value.map(entryResult) : entryResult(value), init)
        const path = pathAfter(request, base)
        const method = request.method.toUpperCase()
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            const origin = request.headers.get('origin')
            const site = request.headers.get('sec-fetch-site')
            if (origin !== null ? origin !== new URL(request.url).origin : site !== null && site !== 'same-origin') {
                throw new SiteAdminError('SITE_ADMIN_FORBIDDEN', 'Management mutations require the same origin.')
            }
        }
        const entryFor = async (id: string, action: Parameters<SiteAdmin['can']>[2]) => {
            const entry = await siteAdmin.getEntry(id)
            redactError = !siteAdmin.can(actor, 'model', 'readDraft', entry.model)
            siteAdmin.assertPermission(actor, 'model', action, entry.model)
            return entry
        }
        if (method === 'GET' && path.length === 1 && path[0] === 'models') return json(siteAdmin.descriptorFor(actor))
        if (method === 'GET' && path.length === 1 && path[0] === 'diagnostics') {
            siteAdmin.assertPermission(actor, 'system', 'diagnostics')
            return json(await siteAdmin.inspect())
        }
        if (method === 'GET' && path.length === 1 && path[0] === 'routes') {
            siteAdmin.assertPermission(actor, 'system', 'diagnostics')
            return json(await siteAdmin.routeSnapshot())
        }
        if (method === 'GET' && path.length === 1 && path[0] === 'entries') {
            const url = new URL(request.url)
            const model = url.searchParams.get('model') ?? undefined
            if (model) siteAdmin.assertPermission(actor, 'model', 'readDraft', model)
            let entries = await siteAdmin.listEntries(model)
            if (!model) entries = entries.filter((entry) => siteAdmin.can(actor, 'model', 'readDraft', entry.model))
            const locale = url.searchParams.get('locale')
            const query = url.searchParams.get('q')?.toLocaleLowerCase()
            const limit = Number(url.searchParams.get('limit') ?? 50)
            const offset = Number(url.searchParams.get('offset') ?? 0)
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
                throw new SiteAdminError(
                    'SITE_ADMIN_INVALID_INPUT',
                    'limit must be 1–100 and offset a non-negative integer.',
                )
            if (locale) entries = entries.filter((entry) => entry.locale === locale)
            if (query) {
                entries = entries.filter(
                    (entry) =>
                        entry.slug.toLocaleLowerCase().includes(query) ||
                        JSON.stringify(entry.data).toLocaleLowerCase().includes(query),
                )
            }
            return json({ items: entries.slice(offset, offset + limit), total: entries.length, limit, offset })
        }
        if (method === 'POST' && path.length === 2 && path[0] === 'entries') {
            redactError = !siteAdmin.can(actor, 'model', 'readDraft', path[1])
            siteAdmin.assertPermission(actor, 'model', 'create', requiredString(path[1], 'model'))
            const body = await bodyObject(request)
            const data = body.data
            if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"data" must be an object.')
            }
            return json(
                await siteAdmin.createEntry(requiredString(path[1], 'model'), {
                    actorId: actor.id,
                    data: data as Record<string, unknown>,
                    ...(typeof body.id === 'string' ? { id: body.id } : {}),
                    ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
                    ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
                    ...(typeof body.sortOrder === 'number' || body.sortOrder === null
                        ? { sortOrder: body.sortOrder }
                        : {}),
                    ...(typeof body.translationGroup === 'string' ? { translationGroup: body.translationGroup } : {}),
                }),
                { status: 201 },
            )
        }
        if (method === 'POST' && path.length === 3 && path[0] === 'entries' && path[2] === 'reorder') {
            const model = requiredString(path[1], 'model')
            redactError = !siteAdmin.can(actor, 'model', 'readDraft', model)
            siteAdmin.assertPermission(actor, 'model', 'sort', model)
            const body = await bodyObject(request)
            if (!Array.isArray(body.items))
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"items" must be an array.')
            return json(await siteAdmin.setSortOrders(model, body.items))
        }
        if (path[0] === 'entries' && path[1]) {
            const id = path[1]
            if (method === 'GET' && path.length === 2) return json(await entryFor(id, 'readDraft'))
            if (method === 'GET' && path.length === 3 && path[2] === 'revisions') {
                await entryFor(id, 'readDraft')
                return json(await siteAdmin.listRevisions(id))
            }
            if (method === 'GET' && path.length === 3 && path[2] === 'references') {
                await entryFor(id, 'readDraft')
                const url = new URL(request.url)
                const view = url.searchParams.get('view')
                if (view !== 'current' && view !== 'published') {
                    throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"view" must be "current" or "published".')
                }
                const references = await siteAdmin.referencesTo(id, {
                    ...(url.searchParams.get('field') ? { field: url.searchParams.get('field')! } : {}),
                    ...(url.searchParams.get('from') ? { from: url.searchParams.get('from')! } : {}),
                    view,
                })
                return json(
                    references.filter((reference) => siteAdmin.can(actor, 'model', 'readDraft', reference.model)),
                )
            }
            if (method === 'PATCH' && path.length === 2) {
                await entryFor(id, 'update')
                const body = await bodyObject(request)
                if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
                    throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"data" must be an object.')
                }
                return json(
                    await siteAdmin.updateEntry(id, {
                        actorId: actor.id,
                        data: body.data as Record<string, unknown>,
                        expectedVersion: expectedVersion(body.expectedVersion),
                        ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
                    }),
                )
            }
            if (method === 'DELETE' && path.length === 2) {
                await entryFor(id, 'delete')
                // Some HTTP adapters discard DELETE bodies. If-Match carries the same optimistic version.
                const match = request.headers.get('if-match')
                const body =
                    match === null
                        ? await bodyObject(request)
                        : {
                              expectedVersion: /^"\d+"$/u.test(match) ? Number(match.slice(1, -1)) : NaN,
                          }
                await siteAdmin.deleteEntry(id, {
                    actorId: actor.id,
                    expectedVersion: expectedVersion(body.expectedVersion),
                })
                return new Response(null, { status: 204 })
            }
            if (method === 'POST' && path[2] === 'publish') {
                await entryFor(id, 'publish')
                const body = await bodyObject(request)
                return json(
                    await siteAdmin.publishEntry(id, {
                        actorId: actor.id,
                        expectedVersion: expectedVersion(body.expectedVersion),
                        ...(typeof body.revisionId === 'string' ? { revisionId: body.revisionId } : {}),
                    }),
                )
            }
            if (method === 'POST' && path[2] === 'unpublish') {
                await entryFor(id, 'publish')
                const body = await bodyObject(request)
                return json(
                    await siteAdmin.unpublishEntry(id, {
                        actorId: actor.id,
                        expectedVersion: expectedVersion(body.expectedVersion),
                    }),
                )
            }
            if (method === 'POST' && path[2] === 'schedule') {
                await entryFor(id, 'schedule')
                const body = await bodyObject(request)
                return json(
                    await siteAdmin.schedulePublish(id, {
                        actorId: actor.id,
                        at: requiredString(body.at, 'at'),
                        expectedVersion: expectedVersion(body.expectedVersion),
                        ...(typeof body.revisionId === 'string' ? { revisionId: body.revisionId } : {}),
                    }),
                )
            }
            if (method === 'POST' && path[2] === 'cancel-schedule') {
                await entryFor(id, 'schedule')
                const body = await bodyObject(request)
                return json(
                    await siteAdmin.cancelScheduledPublish(id, {
                        expectedVersion: expectedVersion(body.expectedVersion),
                    }),
                )
            }
            if (method === 'PATCH' && path[2] === 'sort') {
                await entryFor(id, 'sort')
                const body = await bodyObject(request)
                const order = body.sortOrder
                if (typeof order !== 'number' && order !== null) {
                    throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"sortOrder" must be a number or null.')
                }
                return json(await siteAdmin.setSortOrder(id, order, expectedVersion(body.expectedVersion)))
            }
            if (method === 'POST' && path.length === 4 && path[2] === 'ai') {
                await entryFor(id, 'ai')
                await entryFor(id, 'readDraft')
                return json(
                    await siteAdmin.runAIAction(id, requiredString(path[3], 'action'), await bodyObject(request)),
                )
            }
            if (method === 'POST' && path.length === 5 && path[2] === 'revisions' && path[4] === 'restore') {
                await entryFor(id, 'restore')
                const body = await bodyObject(request)
                return json(
                    await siteAdmin.restoreRevision(id, requiredString(path[3], 'revisionId'), {
                        actorId: actor.id,
                        expectedVersion: expectedVersion(body.expectedVersion),
                    }),
                )
            }
            if (method === 'POST' && path.length === 4 && path[2] === 'revisions' && path[3] === 'prune') {
                await entryFor(id, 'prune')
                const body = await bodyObject(request)
                if (typeof body.retain !== 'number') {
                    throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"retain" is required.')
                }
                return json(await siteAdmin.pruneRevisions(id, body.retain))
            }
        }
        if (method === 'POST' && path.length === 1 && path[0] === 'assets') {
            siteAdmin.assertPermission(actor, 'asset', 'upload')
            const contentType = request.headers.get('content-type') ?? undefined
            if (contentType?.startsWith('multipart/form-data')) {
                throw new SiteAdminError(
                    'SITE_ADMIN_INVALID_INPUT',
                    'Send the raw file body with x-filename and x-upload-size.',
                )
            }
            if (!request.body) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Upload body is required.')
            const size = request.headers.get('x-upload-size')
            if (!size || !/^[1-9]\d*$/u.test(size))
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'x-upload-size must be a positive byte count.')
            let filename: string
            try {
                filename = decodeURIComponent(requiredString(request.headers.get('x-filename'), 'x-filename'))
            } catch {
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'x-filename must be a URL-encoded filename.')
            }
            return json(
                await siteAdmin.uploadAsset({
                    actorId: actor.id,
                    body: request.body,
                    ...(contentType ? { contentType } : {}),
                    filename,
                    size: Number(size),
                }),
                { status: 201 },
            )
        }
        if (path[0] === 'assets' && path[1]) {
            if (method === 'GET' && path.length === 2) {
                siteAdmin.assertPermission(actor, 'asset', 'read')
                return json(await siteAdmin.getAsset(path[1]))
            }
            if (method === 'GET' && path[2] === 'content') {
                siteAdmin.assertPermission(actor, 'asset', 'read')
                const { asset, file } = await siteAdmin.downloadAsset(path[1], false)
                return assetResponse(request, asset, file, true)
            }
            if (method === 'DELETE' && path.length === 2) {
                siteAdmin.assertPermission(actor, 'asset', 'delete')
                await siteAdmin.deleteAsset(path[1])
                return new Response(null, { status: 204 })
            }
        }
        if (method === 'POST' && path.length === 2 && path[0] === 'tasks' && path[1] === 'publish-due') {
            siteAdmin.assertPermission(actor, 'system', 'publishDue')
            const result = await siteAdmin.publishDue()
            for (const failure of result.failed) {
                const entry = await siteAdmin.getEntry(failure.entryId).catch(() => null)
                if (!entry || !siteAdmin.can(actor, 'model', 'readDraft', entry.model))
                    failure.message = 'Scheduled publication failed.'
            }
            return json(result)
        }
        if (method === 'POST' && path.length === 2 && path[0] === 'tasks' && path[1] === 'asset-gc') {
            siteAdmin.assertPermission(actor, 'asset', 'gc')
            return json(await siteAdmin.runAssetGC())
        }
        return json(
            { error: { code: 'SITE_ADMIN_NOT_FOUND', message: 'Management route not found.' } },
            { status: 404 },
        )
    } catch (error) {
        if (redactError && error instanceof SiteAdminError)
            return errorResponse(
                new SiteAdminError(
                    error.code,
                    error.code === 'SITE_ADMIN_STORAGE_UNAVAILABLE'
                        ? 'The entry was saved, but Asset synchronization needs retry.'
                        : 'The requested operation failed.',
                ),
            )
        return errorResponse(error)
    }
}

export const handleManagementRequest = async (
    siteAdmin: SiteAdmin,
    request: Request,
    base = '/api/site-admin',
    context?: unknown,
): Promise<Response> => {
    const response = await handleManagementRequestInner(siteAdmin, request, base, context)
    response.headers.set('cache-control', 'private, no-store')
    response.headers.set('x-content-type-options', 'nosniff')
    return response
}

const publicDescriptor = (siteAdmin: SiteAdmin): unknown => {
    const descriptor = siteAdmin.descriptor
    descriptor.models = Object.fromEntries(Object.entries(descriptor.models).filter(([, model]) => model.public))
    return descriptor
}

export const handlePublicRequest = async (
    siteAdmin: SiteAdmin,
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
                    const content = await siteAdmin.content(modelName, locale)
                    if (path.length === 1) response = jsonResponse(await content.list())
                    else {
                        const key = path.slice(1).join('/')
                        const item = (await content.list()).find((document) => {
                            const metadata = document.data['_siteAdmin'] as { id?: string; slug?: string } | undefined
                            return metadata?.id === key || metadata?.slug === key
                        })
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
