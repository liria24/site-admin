import type { ModelDefinition } from '../config'
import type { TranslationInput, Translations } from '../i18n'
import { SiteAdminError } from '../errors'
import { validateModelData } from '../validation'

/** A locale update replaces that sparse override; absent locales are preserved. */
export const prepareTranslations = async (
    definition: ModelDefinition,
    data: Record<string, unknown>,
    defaultLocale: string,
    supported: readonly string[],
    input: TranslationInput = {},
    previous: Translations = {},
): Promise<Translations> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Translations must be an object.')
    const output: Translations = structuredClone(previous)
    for (const [locale, value] of Object.entries(input)) {
        if (!supported.includes(locale) || locale === defaultLocale)
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Invalid translation locale "${locale}".`)
        if (value === null) delete output[locale]
        else {
            if (typeof value !== 'object' || Array.isArray(value))
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Translation data must be an object.')
            output[locale] = structuredClone(value)
        }
    }
    for (const [locale, value] of Object.entries(output)) {
        for (const key of Object.keys(value))
            if (!definition.fields[key]?.i18n)
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Field "${key}" is not translatable.`)
        const validated = await validateModelData(definition, { ...data, ...value })
        if (!validated.data)
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Invalid ${locale} translation.`, validated.issues)
        output[locale] = Object.fromEntries(Object.keys(value).map((key) => [key, validated.data![key]]))
    }
    return output
}
