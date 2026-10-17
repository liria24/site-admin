export interface PresentationContext {
    locale: string
    t: (key: string, values?: Record<string, unknown> | number) => string
}
export type Localized<Value> = Value | ((context: PresentationContext) => Value)
export type ModelMeta = { label: string; plural: string; icon?: string } & Record<string, unknown>

export const resolvePresentation = <Value>(value: Localized<Value>, context: PresentationContext): Value =>
    typeof value === 'function' ? (value as (context: PresentationContext) => Value)(context) : value

export const literalPresentation: PresentationContext = {
    locale: '',
    t: () => {
        throw new Error('[site-admin] Translated presentation requires Nuxt i18n.')
    },
}
