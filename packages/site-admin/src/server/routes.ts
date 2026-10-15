import type { ModelDefinition, ModelRouteOptions } from '../config'
import { SiteAdminError } from '../errors'

const reserved = ['/api', '/_nuxt', '/_ipx', '/__nuxt', '/_site-admin', '/favicon.ico', '/llms.txt', '/llms-full.txt']

const routeOptions = (definition: ModelDefinition): ModelRouteOptions | null => {
    if (!definition.route) return null
    if (definition.route === true) return {}
    return typeof definition.route === 'string' ? { path: definition.route } : definition.route
}

export const modelRouteOptions = routeOptions

export const entryPath = (
    modelName: string,
    definition: ModelDefinition,
    entry: { id: string; data: Record<string, unknown> },
    apiBases: readonly string[] = ['/api/content', '/api/site-admin'],
): string | null => {
    const options = routeOptions(definition)
    if (!options) return null
    const pattern = options.path ?? `/${modelName}/:id`
    const path = pattern.replace(/:([A-Za-z0-9_-]+)/gu, (_match, key: string) => {
        const value = key === 'id' ? entry.id : entry.data[key]
        if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '')
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Route field "${key}" is required.`, [
                { path: key, message: 'Required for this public route.' },
            ])
        return encodeURIComponent(String(value))
    })
    if (
        !path.startsWith('/') ||
        path.includes('//') ||
        path.includes('?') ||
        path.includes('#') ||
        !/:[A-Za-z0-9_-]+/u.test(pattern) ||
        path.includes('\\') ||
        /(?:^|\/)(?:\.|\.\.)(?:\/|$)/u.test(path)
    ) {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Invalid route pattern for model "${modelName}".`)
    }
    if (reserved.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        throw new SiteAdminError('SITE_ADMIN_ROUTE_CONFLICT', `Route "${path}" is reserved by Nuxt or Site Admin.`)
    }
    if (apiBases.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        throw new SiteAdminError('SITE_ADMIN_ROUTE_CONFLICT', `Route "${path}" conflicts with a Site Admin API.`)
    }
    return path
}

export const routeRedirect = (
    definition: ModelDefinition,
    data: Record<string, unknown>,
): { status: 301 | 302 | 307 | 308; target: string } | null => {
    const options = routeOptions(definition)
    if (!options?.redirect) return null
    const target = data[options.redirect]
    if (typeof target !== 'string') {
        throw new SiteAdminError(
            'SITE_ADMIN_INVALID_INPUT',
            `Redirect field "${options.redirect}" must contain an absolute URL.`,
        )
    }
    try {
        const url = new URL(target)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
        throw new SiteAdminError(
            'SITE_ADMIN_INVALID_INPUT',
            `Redirect field "${options.redirect}" must contain an absolute HTTP(S) URL.`,
        )
    }
    return { status: options.status ?? 302, target }
}
