import type { SiteAdminOptions, PublicEntry, PublicEntrySeo } from './types'
import type { StoragePublishedEntry as PublishedRow } from '../storage'
import type { ModelDefinition } from '../config'
import type { AnyField, AssetInput, FieldRecord } from '../fields'
import { entryDescription, cleanText } from '../markdown/document'
import { resolveMarkdownSource } from '../markdown/assets'
import { serializeSiteAdminSeo } from '../seo'
import { SiteAdminError } from '../errors'
import { resolveTranslation } from '../i18n'
import { entryPath, modelRouteOptions, routeRedirect } from './routes'
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
export interface ProjectionBudget {
    nodes: number
}
/** Public projection is pure: it consumes a validated graph and never reads storage. */
export class PublicProjector<Context> {
    generation = -1
    readonly availableLocales = new WeakMap<PublishedRow, Set<string>>()
    constructor(private readonly options: SiteAdminOptions<Context>) {}
    #publicModel(name: string) {
        const definition = this.options.config.models[name]
        return definition?.public === false ? undefined : definition
    }
    #localizedPath(_definition: ModelDefinition, path: string, locale: string) {
        return this.options.locales?.localizePath?.(path, locale) ?? path
    }
    #publicBase() {
        return (this.options.publicBase ?? '/api/content').replace(/\/$/u, '')
    }
    #apiBases() {
        return [
            (this.options.publicBase ?? '/api/content').replace(/\/$/u, ''),
            (this.options.managementBase ?? '/api/site-admin').replace(/\/$/u, ''),
        ]
    }
    path(row: PublishedRow): string | null {
        const definition = this.#publicModel(row.model)
        if (!definition) return null
        const redirect = routeRedirect(definition, row.data)
        const basePath =
            this.options.routing?.enabled === false || (redirect && this.options.routing?.redirects === false)
                ? null
                : entryPath(row.model, definition, row, this.#apiBases())
        return basePath === null ? null : this.#localizedPath(definition, basePath, row.locale)
    }

    #seoUrl(value: string): string | undefined {
        try {
            const url = new URL(value, this.options.site?.url ?? 'http://site-admin.local')
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
            return this.options.site?.url || /^[a-z][a-z\d+.-]*:/iu.test(value) ? url.href : value
        } catch {
            return undefined
        }
    }

    #entrySeo(definition: ModelDefinition, entry: PublicEntry): PublicEntrySeo {
        const result: PublicEntrySeo = {}
        const text = (keys: Array<string | undefined>): string | undefined =>
            keys
                .map((key) => (key && typeof entry.data[key] === 'string' ? cleanText(entry.data[key]) : ''))
                .find(Boolean)
        const title = text([definition.displayFields?.title, 'title', 'name'])
        const description = entryDescription(definition, entry.data).text
        if (title !== undefined) result.title = title
        if (description !== undefined) result.description = description
        if (entry.path) result.canonical = entry.path
        if (entry.alternates) result.alternates = entry.alternates
        if (result.image !== false && !isObject(result.image)) {
            const imageKeys = [
                definition.displayFields?.image,
                ...Object.entries(definition.fields)
                    .filter(([, field]) => field.kind === 'image' || field.kind === 'images')
                    .map(([name]) => name),
            ]
            for (const key of imageKeys) {
                const value = key ? entry.data[key] : undefined
                const image = Array.isArray(value) ? value[0] : value
                if (isObject(image) && typeof image.url === 'string') {
                    result.image = image.url
                    break
                }
            }
        }
        return this.sanitizeSeo(result)
    }

    sanitizeSeo(value: PublicEntrySeo): PublicEntrySeo {
        const result = serializeSiteAdminSeo(value)
        if (typeof result.image === 'string') {
            const image = this.#seoUrl(result.image)
            if (image === undefined) delete result.image
            else result.image = image
        }
        if (result.canonical !== undefined) {
            const canonical = this.#seoUrl(result.canonical)
            if (canonical === undefined) delete result.canonical
            else result.canonical = canonical
        }
        if (result.alternates)
            result.alternates = result.alternates.flatMap((alternate) => {
                const path = this.#seoUrl(alternate.path)
                return path ? [{ locale: alternate.locale, path }] : []
            })
        return result
    }

    assetUrl(id: string): string {
        return `${this.#publicBase()}/_assets/${encodeURIComponent(id)}`
    }

    #publicAsset(value: AssetInput): Record<string, unknown> {
        const reference = typeof value === 'string' ? { id: value } : { ...value }
        return {
            ...reference,
            url: this.assetUrl(reference.id),
        }
    }

    #hydrateField(
        field: AnyField,
        value: unknown,
        graph: Map<string, PublishedRow>,
        trail: Set<string>,
        budget: ProjectionBudget,
        markdownSource: boolean,
    ): unknown {
        if (value === undefined || value === null) return value
        switch (field.kind) {
            case 'relation': {
                if (typeof value !== 'string') return null
                const target = graph.get(value)
                if (!target) return null
                // Related entries remain public projections; markdown-fields only parses this model's schema.
                return this.project(target, graph, trail, budget)
            }
            case 'file':
            case 'image':
                return this.#publicAsset(value as AssetInput)
            case 'images':
                return Array.isArray(value) ? value.map((item) => this.#publicAsset(item as AssetInput)) : []
            case 'object':
                return this.#hydrateFields(
                    field.fields,
                    typeof value === 'object' && value !== null && !Array.isArray(value)
                        ? (value as Record<string, unknown>)
                        : {},
                    graph,
                    trail,
                    budget,
                    markdownSource,
                )
            case 'array':
                return Array.isArray(value)
                    ? value.map((item) => this.#hydrateField(field.item, item, graph, trail, budget, markdownSource))
                    : []
            case 'markdown':
                return typeof value === 'string' && !markdownSource
                    ? resolveMarkdownSource(value, (id) => this.assetUrl(id))
                    : value
            default:
                return value
        }
    }

    #hydrateFields(
        fields: FieldRecord,
        data: Record<string, unknown>,
        graph: Map<string, PublishedRow>,
        trail: Set<string>,
        budget: ProjectionBudget,
        markdownSource: boolean,
    ): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(fields).map(([name, field]) => [
                name,
                this.#hydrateField(field, data[name], graph, trail, budget, markdownSource),
            ]),
        )
    }

    project(
        row: PublishedRow,
        graph: Map<string, PublishedRow>,
        parentTrail = new Set<string>(),
        budget: ProjectionBudget = { nodes: 0 },
        markdownSource = false,
    ): PublicEntry {
        if (parentTrail.size > 16 || ++budget.nodes > 10_000)
            throw new SiteAdminError(
                'SITE_ADMIN_RELATION_LIMIT',
                'Public relations exceed depth 16 or 10,000 projected nodes.',
            )
        const definition = this.#publicModel(row.model)
        if (!definition) throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${row.model}" is private.`)
        const path = this.path(row)
        if (parentTrail.has(row.id)) {
            return {
                data: {},
                id: row.id,
                locale: row.locale,
                defaultLocale: row.defaultLocale,
                model: row.model,
                path,
                publishedAt: row.publishedAt,
                revisionId: row.revisionId,
            }
        }
        const trail = new Set(parentTrail).add(row.id)
        const entry: PublicEntry = {
            data: this.#hydrateFields(definition.fields, row.data, graph, trail, budget, markdownSource),
            id: row.id,
            locale: row.locale,
            defaultLocale: row.defaultLocale,
            model: row.model,
            path,
            publishedAt: row.publishedAt,
            revisionId: row.revisionId,
        }
        if (this.options.locales?.supported?.length && path) {
            entry.alternates = [row.defaultLocale, ...Object.keys(row.translations)]
                .filter((locale) => this.availableLocales.get(row)?.has(locale) ?? true)
                .flatMap((locale) => {
                    const alternate = resolveTranslation(row, locale)
                    const alternatePath = this.path(alternate)
                    return alternatePath ? [{ locale, path: alternatePath }] : []
                })
        }
        if (this.options.locales?.supported?.length) {
            const pattern = modelRouteOptions(definition)?.path ?? '/' + row.model + '/:id'
            const keys = [...pattern.matchAll(/:([A-Za-z0-9_-]+)/gu)].map((match) => match[1]!)
            entry.localeParams = Object.fromEntries(
                this.options.locales.supported.map((locale) => {
                    if (!entry.alternates?.some((alternate) => alternate.locale === locale)) return [locale, false]
                    const variant = resolveTranslation(row, locale)
                    return [
                        locale,
                        Object.fromEntries(
                            keys.map((key) => [key, String(key === 'id' ? row.id : (variant.data[key] ?? ''))]),
                        ),
                    ]
                }),
            )
        }
        entry.seo = this.#entrySeo(definition, entry)
        return entry
    }
}

/** Retry an entire read when publication changes between its DB pages or relation reads. */
export async function readPublicSnapshot<Value>(
    generation: () => Promise<number>,
    read: (generation: number) => Promise<Value>,
    initial?: number,
): Promise<Value> {
    let current = initial ?? (await generation())
    for (let attempt = 0; attempt < 3; attempt++) {
        const result = await read(current)
        const next = await generation()
        if (current === next) return result
        current = next
    }
    throw new SiteAdminError('SITE_ADMIN_CONFLICT', 'Published content changed during retrieval; retry the read.')
}
