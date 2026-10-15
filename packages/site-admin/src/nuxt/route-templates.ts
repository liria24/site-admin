import type { ModuleOptions } from '../nuxt'

export const siteAdminNuxtRouteTemplate = (
    options: Pick<ModuleOptions, 'i18n'>,
    locales: { supported: readonly string[]; strategy: string; defaultLocale?: string },
): string => {
    const imports = ['defineNuxtRouteMiddleware', 'navigateTo', 'useState', 'useRequestURL', 'useNuxtApp']
    const i18nLocale = options.i18n
        ? `const i18n = useNuxtApp().$i18n
  const currentLocale = typeof i18n?.locale === 'string' ? i18n.locale : i18n?.locale?.value
  const pathLocale = to.path.split('/').filter(Boolean)[0]
  const localeCodes = ${JSON.stringify(locales.supported)}
  const locale = ${JSON.stringify(locales.strategy)} === 'no_prefix'
    ? currentLocale
    : localeCodes.includes(pathLocale)
      ? pathLocale
      : ${JSON.stringify(locales.strategy)} === 'prefix_except_default'
        ? ${JSON.stringify(locales.defaultLocale)}
        : currentLocale
  if (locale && locale !== currentLocale && typeof i18n?.locale === 'object') i18n.locale.value = locale`
        : 'const locale = undefined'
    return `import { ${imports.join(', ')} } from '#imports'
import { siteAdminPublicClientOptions } from '#build/site-admin/client'
import { createSiteAdminClient } from '@liria24/site-admin/internal/client'

const requests = new WeakMap()
export default defineNuxtRouteMiddleware(async (to) => {
  const nuxtApp = useNuxtApp()
  const request = Symbol()
  requests.set(nuxtApp, request)
  const origin = useRequestURL().origin
  const client = createSiteAdminClient(siteAdminPublicClientOptions())
  const state = useState('site-admin-route', () => null)
  state.value = null
  ${i18nLocale}
  const result = await client.resolveRoute(to.path, { locale })
  if (requests.get(nuxtApp) !== request) return
  if (!result) return
  if (result.kind === 'redirect') return navigateTo(result.target, { external: result.target.startsWith('http://') || result.target.startsWith('https://'), redirectCode: result.status })
  state.value = { ...result, path: to.path, origin }
})
`
}

export const siteAdminNuxtMetadataTemplate = (
    options: Pick<ModuleOptions, 'seo' | 'ogImage' | 'schemaOrg'>,
): string => {
    const imports = ['defineNuxtPlugin', 'useState', 'useRoute', 'computed']
    if (options.seo) imports.push('useHead')
    if (options.schemaOrg) imports.push('useSchemaOrg')
    return `import { ${imports.join(', ')} } from '#imports'
${options.seo || options.ogImage ? "import { useSiteAdminSeoMetadata } from '#build/site-admin/seo'" : ''}

export default defineNuxtPlugin(() => {
  const resolved = useState('site-admin-route', () => null)
  const current = useRoute()
  const route = computed(() => resolved.value?.path === current.path ? resolved.value : null)
  ${options.seo || options.ogImage ? 'useSiteAdminSeoMetadata(() => route.value?.entry?.seo)' : ''}
  ${options.seo ? 'useHead(() => ({ htmlAttrs: route.value?.entry?.locale ? { lang: route.value.entry.locale } : {} }))' : ''}
  ${
      options.schemaOrg
          ? `useSchemaOrg(computed(() => {
    const seo = route.value?.entry?.seo
    return seo ? [{ '@type': 'WebPage', name: seo.title, description: seo.description }] : []
  }))`
          : ''
  }
})
`
}
