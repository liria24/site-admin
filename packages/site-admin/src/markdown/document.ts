import type { AnyField } from '../fields'
import type { ModelDefinition } from '../config'

export interface MarkdownDocumentValue {
    meta?: { summary?: unknown }
    nodes: unknown[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

export const markdownDocument = (value: unknown): MarkdownDocumentValue | undefined => {
    if (!isObject(value) || !Array.isArray(value.nodes)) return undefined
    const meta = isObject(value.meta) ? value.meta : undefined
    return { ...(meta ? { meta } : {}), nodes: value.nodes }
}

export const astText = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
        if ((typeof value[0] === 'string' || value[0] === null) && isObject(value[1])) {
            return value.slice(2).map(astText).filter(Boolean).join(' ')
        }
        return value.map(astText).filter(Boolean).join(' ')
    }
    if (!isObject(value)) return ''
    if (typeof value.value === 'string') return value.value
    return astText(value.children ?? value.nodes)
}

export const cleanText = (value: string): string => value.replace(/\s+/gu, ' ').trim()

export const entryDescription = (
    definition: ModelDefinition,
    data: Record<string, unknown>,
    format: 'full' | 'summary' = 'full',
): { text?: string; hasMarkdownCandidate: boolean } => {
    const keys = [definition.displayFields?.description, 'description', 'summary'].filter((key): key is string =>
        Boolean(key),
    )
    const hasMarkdownCandidate = keys.some((key) => definition.fields[key]?.kind === 'markdown')
    for (const key of keys) {
        const value = data[key]
        const document = markdownDocument(value)
        const description =
            definition.fields[key]?.kind === 'markdown'
                ? astText(
                      format === 'summary'
                          ? Array.isArray(document?.meta?.summary)
                              ? document.meta.summary
                              : undefined
                          : (document?.meta?.summary ?? document?.nodes),
                  )
                : typeof value === 'string'
                  ? value
                  : ''
        const text = cleanText(description)
        if (text) return { text, hasMarkdownCandidate }
    }
    return { hasMarkdownCandidate }
}

export const collectMarkdown = (field: AnyField, value: unknown, output: MarkdownDocumentValue[]): void => {
    if (field.kind === 'markdown') {
        const document = markdownDocument(value)
        if (document) output.push(document)
        return
    }
    if (field.kind === 'object' && isObject(value)) {
        for (const [name, child] of Object.entries(field.fields)) collectMarkdown(child, value[name], output)
        return
    }
    if (field.kind === 'array' && Array.isArray(value)) {
        for (const item of value) collectMarkdown(field.item, item, output)
    }
}
