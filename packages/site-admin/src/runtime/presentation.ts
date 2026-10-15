import { AsyncLocalStorage } from 'node:async_hooks'
import type { H3Event } from 'h3'
import type { PresentationContext } from '../presentation'
import { literalPresentation } from '../presentation'
import { SiteAdminError } from '../errors'
import type { SiteAdminConfig } from '../config'
import { resolvePresentation } from '../presentation'
import { createSiteAdminRouteResolver, serializeSiteAdminRouteRules, serializeSiteAdminSeo } from '../seo'

const locales = new AsyncLocalStorage<string>()
export const requestedPresentationLocale = () => locales.getStore()

/** Native Nuxt i18n loads messages and returns a translator bound to this request's locale. */
export const createPresentationContext = async (
    event: H3Event | undefined,
    locale: string | undefined,
    native: {
        locales: readonly string[]
        detect: (event: H3Event) => string
        translate: (
            event: H3Event,
        ) => Promise<
            (key: string, values: Record<string, unknown> | number | undefined, options: { locale: string }) => string
        >
    },
): Promise<PresentationContext> => {
    if (!event) return { ...literalPresentation, locale: locale ?? '' }
    const selected = locale || native.detect(event)
    if (!native.locales.includes(selected))
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Unsupported presentation locale.')
    return locales.run(selected, async () => {
        const t = await native.translate(event)
        return { locale: selected, t: (key, values) => t(key, values, { locale: selected }) }
    })
}

export const resolvePublicPresentation = (config: SiteAdminConfig, path: string, context: PresentationContext) => ({
    path,
    locale: context.locale,
    defaults: serializeSiteAdminSeo(config.seo ? resolvePresentation(config.seo, context) : {}),
    route: serializeSiteAdminSeo(
        createSiteAdminRouteResolver(serializeSiteAdminRouteRules(config.routeRules, context))(path).seo,
    ),
})
