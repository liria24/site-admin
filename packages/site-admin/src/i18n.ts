import type { ModelDefinition } from './config'

export type Translations<Data = Record<string, unknown>> = Record<string, Partial<Data>>
export type TranslationInput<Data = Record<string, unknown>> = Record<string, Partial<Data> | null>

const originalData = Symbol('original entry data')

export const resolveTranslation = <
    Entry extends {
        data: Record<string, unknown>
        defaultLocale: string
        translations: Translations
        [originalData]?: Record<string, unknown>
    },
>(
    entry: Entry,
    requested?: string,
) => {
    const locale = requested && Object.hasOwn(entry.translations, requested) ? requested : entry.defaultLocale
    const original = entry[originalData] ?? entry.data
    return { ...entry, [originalData]: original, locale, data: { ...original, ...entry.translations[locale] } }
}

export const translatedRouteFields = (definition: ModelDefinition): string[] => {
    const pattern =
        typeof definition.route === 'string'
            ? definition.route
            : typeof definition.route === 'object'
              ? (definition.route.path ?? '')
              : ''
    return [...pattern.matchAll(/:([A-Za-z0-9_-]+)/gu)]
        .map((match) => match[1]!)
        .filter((key) => definition.fields[key]?.i18n)
}
