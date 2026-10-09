import { comarkContent, type Source, type JsonSchema, type ContentFile } from 'comark-content'
import json from 'comark-content/plugins/json'
import markdownFields, { markdownField } from 'comark-content/plugins/markdown-fields'
import type { ModelDefinition, SiteAdminConfig } from '../config'
import type { AnyField, FieldRecord } from '../fields'
import type { PublicEntry } from '../server/types'
import { SiteAdminError } from '../errors'
import type { AssetUrlResolver } from './assets'
import { markdownPlugins } from './plugins'

const fieldSchema = (field: AnyField): JsonSchema => {
    switch (field.kind) {
        case 'markdown':
            return markdownField()
        case 'text':
        case 'textarea':
        case 'url':
        case 'datetime':
        case 'select':
            return { type: 'string' }
        case 'number':
            return { type: field.integer ? 'integer' : 'number' }
        case 'boolean':
            return { type: 'boolean' }
        case 'object':
            return fieldsSchema(field.fields)
        case 'array':
            return { items: fieldSchema(field.item), type: 'array' }
        case 'images':
            return { items: { type: 'object' }, type: 'array' }
        case 'file':
        case 'image':
        case 'relation':
            return { type: 'object' }
    }
    throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', 'Unsupported field type.')
}

const fieldsSchema = (fields: FieldRecord): JsonSchema => ({
    properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldSchema(field)])),
    type: 'object',
})

export const createMarkdownContent = (
    modelName: string,
    definition: ModelDefinition,
    entries: PublicEntry[],
    options: SiteAdminConfig['markdown'],
    resolve: AssetUrlResolver,
    parsed?: (id: string) => ContentFile | undefined,
) => {
    const items = new Map(
        entries.map((entry) => [
            `${definition.route ? entry.slug : entry.id}.json`,
            {
                ...entry.data,
                _siteAdmin: {
                    ...(entry.alternates ? { alternates: entry.alternates } : {}),
                    id: entry.id,
                    locale: entry.locale,
                    model: entry.model,
                    path: entry.path,
                    publishedAt: entry.publishedAt,
                    revisionId: entry.revisionId,
                    ...(entry.seo ? { seo: entry.seo } : {}),
                    slug: entry.slug,
                },
            },
        ]),
    )
    const source: Source = {
        prefix: `/${modelName}`,
        schema: {
            ...fieldsSchema(definition.fields),
            properties: {
                ...fieldsSchema(definition.fields).properties,
                _siteAdmin: { type: 'object' },
            },
        },
        keys: async () => [...items.keys()],
        getItem: async (key) => JSON.stringify(items.get(key)),
        getItemRaw: async (key) => items.get(key),
    }
    const plugins = markdownPlugins(options, resolve)
    const contentOptions = {
        markdown: { plugins },
        onError: 'throw' as const,
        plugins: [json(), markdownFields()],
        source,
    }
    const raw = comarkContent(modelName, contentOptions)
    if (!parsed) return raw
    // A parsed provider exposes the complete source index. update() before init would
    // persist an incomplete manifest containing only the reused detail documents.
    const content = comarkContent(modelName, {
        ...contentOptions,
        source: {
            parsed: true,
            schema: source.schema!,
            keys: source.keys,
            get: async (key) => {
                const item = items.get(key)
                if (!item) return null
                return parsed(item._siteAdmin.id) ?? raw.get(key)
            },
        },
    })
    raw.hooks.hook('file:parsed', (context) => content.hooks.callHook('file:parsed', context))
    return content
}
