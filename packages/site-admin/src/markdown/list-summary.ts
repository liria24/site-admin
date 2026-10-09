import { parseMarkdown, type Node } from 'comark'
import type { ContentListFile } from 'comark-content'
import type { ModelDefinition, SiteAdminConfig, SiteAdminMarkdownSummary } from '../config'
import type { AnyField, FieldRecord } from '../fields'
import { serializeSiteAdminSeo } from '../seo'
import { astText, cleanText, markdownDocument } from './document'
import { markdownPlugins } from './plugins'
import type { AssetUrlResolver } from './assets'

const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

const boundedText = (value: string): string =>
    Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(cleanText(value)),
        ({ segment }) => segment,
    )
        .slice(0, 280)
        .join('')

/** Fresh transport projection only; the parsed content cache and full/detail contract stay intact. */
export const projectMarkdownListSummary = async (
    files: ContentListFile[],
    modelName: string,
    config: SiteAdminConfig,
    resolve: AssetUrlResolver,
): Promise<ContentListFile[]> => {
    const plugins = markdownPlugins(config.markdown, resolve)
    const fieldValue = async (field: AnyField, value: unknown): Promise<unknown> => {
        if (value === undefined || value === null) return value
        if (field.kind === 'markdown') {
            // Relations are opaque to markdown-fields; parse their source through the same native plugin pipeline.
            const document =
                typeof value === 'string' ? await parseMarkdown(value, { plugins }) : markdownDocument(value)
            const summary = document?.meta?.summary
            const nodes = Array.isArray(summary) ? structuredClone(summary as Node[]) : []
            const result: SiteAdminMarkdownSummary = {
                nodes,
                frontmatter: {},
                meta: Array.isArray(summary) ? { summary: nodes } : {},
            }
            return result
        }
        if (field.kind === 'object' && object(value)) return fieldsValue(field.fields, value)
        if (field.kind === 'array' && Array.isArray(value))
            return Promise.all(value.map((item) => fieldValue(field.item, item)))
        if (field.kind === 'relation' && object(value)) {
            const definition = config.models[field.model]
            if (!definition || !object(value.data)) return null
            const data = await fieldsValue(definition.fields, value.data)
            return {
                ...structuredClone(value),
                data,
                ...(value.seo ? { seo: summarySeo(definition, data, value.seo) } : {}),
            }
        }
        return structuredClone(value)
    }
    const fieldsValue = async (fields: FieldRecord, data: Record<string, unknown>): Promise<Record<string, unknown>> =>
        Object.fromEntries(
            await Promise.all(
                Object.entries(fields)
                    .filter(([key]) => Object.hasOwn(data, key))
                    .map(async ([key, field]) => [key, await fieldValue(field, data[key])]),
            ),
        )
    const summarySeo = (definition: ModelDefinition, data: Record<string, unknown>, value: unknown) => {
        const seo = serializeSiteAdminSeo(value)
        const key = [definition.displayFields?.description, 'description', 'summary'].find(
            (name) => name && data[name] !== undefined,
        )
        if (key && definition.fields[key]?.kind === 'markdown') {
            const document = markdownDocument(data[key])
            const description = boundedText(astText(document?.meta?.summary))
            if (description) seo.description = description
            else delete seo.description
        } else if (seo.description !== undefined) seo.description = boundedText(seo.description)
        return seo
    }
    const definition = config.models[modelName]!
    return Promise.all(
        files.map(async (file) => {
            const data = await fieldsValue(definition.fields, file.data)
            const metadata = file.data['_siteAdmin']
            if (object(metadata))
                data['_siteAdmin'] = {
                    ...structuredClone(metadata),
                    ...(metadata.seo ? { seo: summarySeo(definition, data, metadata.seo) } : {}),
                }
            // Native list identity remains available, but plugin-added copies of content cannot hitchhike in metadata.
            const { kind, type, key, source, extension, stem, partial, hash } = file.meta
            return {
                path: file.path,
                data,
                meta: { kind, type, key, source, extension, stem, partial, ...(hash === undefined ? {} : { hash }) },
            }
        }),
    )
}
