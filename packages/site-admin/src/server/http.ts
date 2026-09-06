import { SiteAdminError } from '../errors'
import type { SiteAdmin } from './site-admin'

const json = (value: unknown, init: ResponseInit = {}): Response => {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify(value), { ...init, headers })
}

const errorResponse = (error: unknown): Response => {
    if (error instanceof SiteAdminError) {
        return json(
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
    return json(
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
    const value: unknown = await request.json()
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
        throw new SiteAdminError(
            'SITE_ADMIN_INVALID_INPUT',
            '"expectedVersion" must be a non-negative integer.',
        )
    }
    return value
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const handleManagementRequestInner = async (
    siteAdmin: SiteAdmin,
    request: Request,
    base = '/api/site-admin',
): Promise<Response> => {
    try {
        const actor = await siteAdmin.authorizeRequest(request)
        const path = pathAfter(request, base)
        const method = request.method.toUpperCase()
        if (method === 'GET' && path.length === 1 && path[0] === 'models') return json(siteAdmin.descriptor)
        if (method === 'GET' && path.length === 1 && path[0] === 'diagnostics')
            return json(await siteAdmin.inspect())
        if (method === 'GET' && path.length === 1 && path[0] === 'entries') {
            return json(
                await siteAdmin.listEntries(new URL(request.url).searchParams.get('model') ?? undefined),
            )
        }
        if (method === 'POST' && path.length === 2 && path[0] === 'entries') {
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
                    ...(typeof body.translationGroup === 'string'
                        ? { translationGroup: body.translationGroup }
                        : {}),
                }),
                { status: 201 },
            )
        }
        if (path[0] === 'entries' && path[1]) {
            const id = path[1]
            if (method === 'GET' && path.length === 2) return json(await siteAdmin.getEntry(id))
            if (method === 'GET' && path[2] === 'revisions') return json(await siteAdmin.listRevisions(id))
            if (method === 'PATCH' && path.length === 2) {
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
                        ...(typeof body.sortOrder === 'number' || body.sortOrder === null
                            ? { sortOrder: body.sortOrder }
                            : {}),
                    }),
                )
            }
            if (method === 'DELETE' && path.length === 2) {
                const body = await bodyObject(request)
                await siteAdmin.deleteEntry(id, {
                    actorId: actor.id,
                    expectedVersion: expectedVersion(body.expectedVersion),
                })
                return new Response(null, { status: 204 })
            }
            if (method === 'POST' && path[2] === 'publish') {
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
                const body = await bodyObject(request)
                return json(
                    await siteAdmin.unpublishEntry(id, {
                        actorId: actor.id,
                        expectedVersion: expectedVersion(body.expectedVersion),
                    }),
                )
            }
            if (method === 'POST' && path[2] === 'schedule') {
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
                const body = await bodyObject(request)
                return json(
                    await siteAdmin.cancelScheduledPublish(id, {
                        expectedVersion: expectedVersion(body.expectedVersion),
                    }),
                )
            }
            if (method === 'PATCH' && path[2] === 'sort') {
                const body = await bodyObject(request)
                const order = body.sortOrder
                if (typeof order !== 'number' && order !== null) {
                    throw new SiteAdminError(
                        'SITE_ADMIN_INVALID_INPUT',
                        '"sortOrder" must be a number or null.',
                    )
                }
                return json(await siteAdmin.setSortOrder(id, order, expectedVersion(body.expectedVersion)))
            }
        }
        if (method === 'POST' && path.length === 1 && path[0] === 'assets') {
            const contentType = request.headers.get('content-type') ?? undefined
            if (contentType?.startsWith('multipart/form-data')) {
                const form = await request.formData()
                const file = form.get('file')
                if (!(file instanceof File)) {
                    throw new SiteAdminError(
                        'SITE_ADMIN_INVALID_INPUT',
                        'Multipart field "file" is required.',
                    )
                }
                return json(
                    await siteAdmin.uploadAsset({
                        actorId: actor.id,
                        body: file,
                        ...(file.type ? { contentType: file.type } : {}),
                        filename: file.name,
                    }),
                    { status: 201 },
                )
            }
            if (!request.body)
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Upload body is required.')
            return json(
                await siteAdmin.uploadAsset({
                    actorId: actor.id,
                    body: request.body,
                    ...(contentType ? { contentType } : {}),
                    filename: requiredString(request.headers.get('x-filename'), 'x-filename'),
                }),
                { status: 201 },
            )
        }
        if (path[0] === 'assets' && path[1]) {
            if (method === 'GET' && path.length === 2) return json(await siteAdmin.getAsset(path[1]))
            if (method === 'GET' && path[2] === 'content') {
                const { asset, file } = await siteAdmin.downloadAsset(path[1], false)
                return new Response(file.stream(), {
                    headers: {
                        'cache-control': 'private, no-store',
                        'content-length': String(asset.size),
                        'content-type': asset.contentType,
                    },
                })
            }
            if (method === 'DELETE' && path.length === 2) {
                await siteAdmin.deleteAsset(path[1])
                return new Response(null, { status: 204 })
            }
        }
        if (method === 'POST' && path.length === 2 && path[0] === 'tasks' && path[1] === 'publish-due') {
            return json(await siteAdmin.publishDue())
        }
        if (method === 'POST' && path.length === 2 && path[0] === 'tasks' && path[1] === 'asset-gc') {
            return json(await siteAdmin.runAssetGC())
        }
        return json(
            { error: { code: 'SITE_ADMIN_NOT_FOUND', message: 'Management route not found.' } },
            { status: 404 },
        )
    } catch (error) {
        return errorResponse(error)
    }
}

export const handleManagementRequest = async (
    siteAdmin: SiteAdmin,
    request: Request,
    base = '/api/site-admin',
): Promise<Response> => {
    const response = await handleManagementRequestInner(siteAdmin, request, base)
    response.headers.set('cache-control', 'private, no-store')
    response.headers.set('x-content-type-options', 'nosniff')
    return response
}

const publicDescriptor = (siteAdmin: SiteAdmin): unknown => {
    const descriptor = siteAdmin.descriptor
    descriptor.models = Object.fromEntries(
        Object.entries(descriptor.models).filter(([, model]) => model.public),
    )
    return descriptor
}

export const handlePublicRequest = async (
    siteAdmin: SiteAdmin,
    request: Request,
    base = '/api/content',
): Promise<Response> => {
    try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return json(
                { error: { code: 'SITE_ADMIN_METHOD_NOT_ALLOWED', message: 'Method not allowed.' } },
                { status: 405 },
            )
        }
        const path = pathAfter(request, base)
        if (path.length === 1 && path[0] === 'models') return json(publicDescriptor(siteAdmin))
        if (path.length === 1 && path[0] === '_sitemap') return json(await siteAdmin.sitemap())
        if (path.length === 1 && path[0] === '_route') {
            const route = new URL(request.url).searchParams.get('path')
            if (!route)
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Query parameter "path" is required.')
            const result = await siteAdmin.resolvePath(route)
            return result ? json(result) : json(null, { status: 404 })
        }
        if (path[0] === '_assets' && path[1]) {
            const { asset, file } = await siteAdmin.downloadAsset(path[1], true)
            return new Response(request.method === 'HEAD' ? null : file.stream(), {
                headers: {
                    'cache-control': 'public, max-age=31536000, immutable',
                    'content-length': String(asset.size),
                    'content-type': asset.contentType,
                    etag: `"sha256-${asset.checksum ?? asset.id}"`,
                    'x-content-type-options': 'nosniff',
                },
            })
        }
        const modelName = optionalString(path[0])
        if (!modelName)
            return json({ models: Object.keys((publicDescriptor(siteAdmin) as { models: object }).models) })
        const content = await siteAdmin.content(modelName)
        if (path.length === 1) return json(await content.list(modelName))
        const item = await content.get(`/${modelName}/${path.slice(1).join('/')}`)
        return item ? json(item) : json(null, { status: 404 })
    } catch (error) {
        return errorResponse(error)
    }
}
