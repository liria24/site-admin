import { addRoute, createRouter, findAllRoutes } from 'rou3'
import type { PublicEntrySeo, PublicEntrySeoValue } from './server/types'

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const seoJsonValue = (value: unknown, parents = new Set<object>()): PublicEntrySeoValue | undefined => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value !== 'object' || parents.has(value) || parents.size > 32) return undefined
    const trail = new Set(parents).add(value)
    if (Array.isArray(value)) return value.map((item) => seoJsonValue(item, trail) ?? null)
    if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
    return Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
            const resolved = seoJsonValue(item, trail)
            return resolved === undefined ? [] : [[key, resolved]]
        }),
    )
}

/** Pick the public DTO contract explicitly, never spread server configuration or resolver results. */
export const serializeSiteAdminSeo = (value: unknown): PublicEntrySeo => {
    if (!isObject(value)) return {}
    const result: PublicEntrySeo = {}
    for (const key of ['title', 'titleTemplate', 'description', 'canonical', 'robots'] as const)
        if (typeof value[key] === 'string') result[key] = value[key]
    if (value.titleTemplate === null) result.titleTemplate = null
    if (value.type === 'article' || value.type === 'website') result.type = value.type
    if (value.twitterCard === 'summary' || value.twitterCard === 'summary_large_image')
        result.twitterCard = value.twitterCard
    if (value.image === false || typeof value.image === 'string') result.image = value.image
    else if (isObject(value.image) && typeof value.image.component === 'string') {
        const props = seoJsonValue(value.image.props)
        const options = seoJsonValue(value.image.options)
        result.image = {
            component: value.image.component,
            ...(isObject(props) ? { props: props as Record<string, PublicEntrySeoValue> } : {}),
            ...(isObject(options)
                ? { options: options as Record<string, PublicEntrySeoValue> }
                : Array.isArray(options)
                  ? {
                        options: options.filter(isObject) as Array<Record<string, PublicEntrySeoValue>>,
                    }
                  : {}),
        }
    }
    if (Array.isArray(value.alternates))
        result.alternates = value.alternates.flatMap((alternate: unknown) =>
            isObject(alternate) && typeof alternate.locale === 'string' && typeof alternate.path === 'string'
                ? [{ locale: alternate.locale, path: alternate.path }]
                : [],
        )
    return result
}

export interface SiteAdminRouteRule {
    llms?: boolean
    seo?: PublicEntrySeo
    sitemap?: boolean
}

export type SiteAdminRouteRules = Record<string, SiteAdminRouteRule>
export type SiteAdminRouteResolver = (path: string) => SiteAdminRouteRule

/** Resolve only pathname. Query/hash and URL origins never change the matching route. */
export const normalizeSiteAdminPath = (path: string): string => new URL(path, 'http://site-admin.local').pathname

/** Later defined values replace earlier values; image component descriptors are atomic. */
export const mergeSiteAdminSeo = <Options extends object = PublicEntrySeo>(
    ...layers: Array<Options | undefined>
): Options =>
    Object.fromEntries(
        layers.flatMap((layer) => Object.entries(layer ?? {}).filter(([, value]) => value !== undefined)),
    ) as Options

export const serializeSiteAdminRouteRules = (value: unknown): SiteAdminRouteRules => {
    if (!isObject(value)) return {}
    return Object.fromEntries(
        Object.entries(value).flatMap(([path, rule]) => {
            if (!isObject(rule)) return []
            return [
                [
                    path,
                    {
                        ...(typeof rule.llms === 'boolean' ? { llms: rule.llms } : {}),
                        ...(typeof rule.sitemap === 'boolean' ? { sitemap: rule.sitemap } : {}),
                        ...(isObject(rule.seo) ? { seo: serializeSiteAdminSeo(rule.seo) } : {}),
                    },
                ],
            ]
        }),
    )
}

/** rou3 returns overlapping matches from least to most specific, independent of declaration order. */
export const createSiteAdminRouteResolver = (rules?: SiteAdminRouteRules): SiteAdminRouteResolver => {
    const router = createRouter<SiteAdminRouteRule>()
    for (const [path, rule] of Object.entries(serializeSiteAdminRouteRules(rules))) addRoute(router, 'GET', path, rule)
    return (path) => {
        const result: SiteAdminRouteRule = {}
        for (const { data } of findAllRoutes(router, 'GET', normalizeSiteAdminPath(path), {
            params: false,
            normalize: true,
        })) {
            if (data.llms !== undefined) result.llms = data.llms
            if (data.sitemap !== undefined) result.sitemap = data.sitemap
            if (data.seo !== undefined) result.seo = mergeSiteAdminSeo(result.seo, data.seo)
        }
        return result
    }
}
