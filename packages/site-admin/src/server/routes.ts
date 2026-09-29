import type { ModelDefinition, ModelRouteOptions } from '../config'
import { SiteAdminError } from '../errors'

const reserved = ['/api', '/_nuxt', '/_ipx', '/__nuxt', '/_site-admin', '/favicon.ico', '/llms.txt', '/llms-full.txt']

export const slugify = (value: string, maxLength = 80): string =>
    value
        .normalize('NFKD')
        .toLocaleLowerCase('en-US')
        .replace(/[\p{M}]/gu, '')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, maxLength)
        .replace(/-+$/u, '')

export const validateSlug = (value: string, maxLength = 80): string => {
    if (!value || value.length > maxLength || value.includes('/') || value.includes('?') || value.includes('#')) {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Slug must be 1-${maxLength} URL-path characters.`)
    }
    return value
}

const routeOptions = (definition: ModelDefinition): ModelRouteOptions | null => {
    if (!definition.route) return null
    if (definition.route === true) return {}
    return typeof definition.route === 'string' ? { path: definition.route } : definition.route
}

export const modelRouteOptions = routeOptions

export const entryPath = (
    modelName: string,
    definition: ModelDefinition,
    slug: string,
    apiBases: readonly string[] = ['/api/content', '/api/site-admin'],
): string | null => {
    const options = routeOptions(definition)
    if (!options) return null
    const pattern = options.path ?? `/${modelName}/:slug`
    const path = pattern.replaceAll(':slug', encodeURIComponent(slug)).replace(/\/{2,}/gu, '/')
    if (
        !path.startsWith('/') ||
        path.includes('?') ||
        path.includes('#') ||
        (pattern === path && !pattern.includes(':slug'))
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

export const preferredSlugSource = (definition: ModelDefinition, data: Record<string, unknown>): string | undefined => {
    const explicit = definition.displayFields?.title
    if (explicit && typeof data[explicit] === 'string') return data[explicit]
    for (const key of ['title', 'name']) {
        if (typeof data[key] === 'string') return data[key]
    }
    for (const [key, field] of Object.entries(definition.fields)) {
        if (field.kind === 'text' && typeof data[key] === 'string') return data[key]
    }
    return undefined
}
