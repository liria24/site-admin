import { normalize } from 'pathe'

export interface SiteAdminClientTemplateOptions {
    basePath: string
    managementBase: string
    defaultLocale?: string
    i18n?: boolean
    origin?: string
    auth?: boolean
    aiActions?: boolean
}

/** Generated code contains connection settings, native factory macros and exports only. */
export const siteAdminNuxtClientTemplate = (options: SiteAdminClientTemplateOptions): string => `
import { createUseAsyncData } from '#app/composables/asyncData'
import { createUseFetch } from '#app/composables/fetch'
import { createSiteAdminComposables, siteAdminAiFetchOptions } from '@liria24/site-admin/internal/runtime/composables'
${options.auth ? "import { useUserSession } from '#imports'" : ''}
export const siteAdminAsyncData = createUseAsyncData()
export const siteAdminAiFetch = createUseFetch(siteAdminAiFetchOptions)
export const { useContent, ${options.aiActions ? 'useAi, ' : ''}siteAdminPublicClientOptions, siteAdminManagementClientOptions, useAdminClient, useSiteAdminRoute, siteAdminAttachAsyncData, useSiteAdminAuthScope, siteAdminManagementKey, createNuxtSiteAdminManagementClient, useSiteAdminModels, siteAdminReadModels, useAdminEntries, useAdminEntry } = createSiteAdminComposables(${JSON.stringify(options)}, siteAdminAsyncData, siteAdminAiFetch${options.auth ? ', useUserSession' : ''})
export type { UseAiOptions, SiteAdminModelOptions, SiteAdminLocaleOptions, SiteAdminBatchRequest, SiteAdminBatchResult } from '@liria24/site-admin/internal/runtime/composables'
`

/** The resource already owns loading, identity and errors. Form setup stays synchronous. */
export const siteAdminNuxtFormTemplate = (): string => `export { useEntryForm } from '@liria24/site-admin/internal/form'
`

/** A config path is used only by TypeScript; the app never loads its runtime code. */
export const siteAdminNuxtModelTypes = (
    configPath: string,
    environments: readonly string[] = [],
): string => `import '@liria24/site-admin/internal/client'
import type { InferSiteAdminModels, InferSiteAdminFormModels, InferSiteAdminNamedAiActions, InferSiteAdminPublicModels, ResolvedSiteAdminConfig } from '@liria24/site-admin'
import type { EntryPrepareContext } from '@liria24/site-admin'

declare module '#app' {
  interface RuntimeNuxtHooks {
    'site-admin:entry:prepare': (context: EntryPrepareContext) => void | Promise<void>
  }
}

type SiteAdminDomainConfig = ResolvedSiteAdminConfig<typeof import(${JSON.stringify(normalize(configPath))}).default, readonly [${environments.map((environment) => JSON.stringify(environment)).join(', ')}]>

declare module '@liria24/site-admin/internal/client' {
  interface SiteAdminClientRegistry {
    managementModels: InferSiteAdminModels<SiteAdminDomainConfig>
    formModels: InferSiteAdminFormModels<SiteAdminDomainConfig>
    namedAiActions: InferSiteAdminNamedAiActions<SiteAdminDomainConfig>
    publicModels: InferSiteAdminPublicModels<SiteAdminDomainConfig>
    publicSummaryModels: InferSiteAdminPublicModels<SiteAdminDomainConfig, 'summary'>
  }
}
export {}
`

export interface SiteAdminSeoTemplateOptions {
    ogImage: boolean
    seo?: boolean
}

/** Page-owned SEO stays reactive and framework integration never enters Core. */
export const siteAdminNuxtSeoTemplate = (
    options: SiteAdminSeoTemplateOptions,
): string => `import { useSeoMeta, useRoute, useRuntimeConfig, useRequestURL${options.seo === false ? '' : ', useHead'}${options.ogImage ? ', useNuxtApp, tryUseNuxtApp, defineOgImage' : ''} } from '#imports'
import { computed, toValue${options.ogImage ? ', getCurrentScope, ref, watch' : ''}, type MaybeRefOrGetter } from 'vue'
import { createSiteAdminRouteResolver, mergeSiteAdminSeo } from '@liria24/site-admin/internal/seo'
import type { SiteAdminRouteRules } from '@liria24/site-admin/internal/seo'
import type { PublicEntrySeo } from '@liria24/site-admin'

${
    options.ogImage
        ? `type NativeOgImage = {
  component: Parameters<typeof defineOgImage>[0]
  props?: Parameters<typeof defineOgImage>[1]
  options?: Parameters<typeof defineOgImage>[2]
}
`
        : ''
}
export type PageSeoOptions = Omit<PublicEntrySeo, 'image'> & {
  image?: string | false${options.ogImage ? ' | NativeOgImage' : ''}
}
type SeoInput = PublicEntrySeo | PageSeoOptions

export const useSiteAdminSeoMetadata = (
  input: MaybeRefOrGetter<SeoInput | null | undefined> = {},
  pageOverride?: MaybeRefOrGetter<PageSeoOptions | null | undefined>,
  headPriority?: 'critical',
): void => {
  const config = (useRuntimeConfig().public.siteAdmin ?? {}) as { seo?: PublicEntrySeo; routeRules?: SiteAdminRouteRules }
  const route = useRoute()
  const origin = useRequestURL().origin
  const resolveRoute = createSiteAdminRouteResolver(config.routeRules)
  const resolved = computed(() => mergeSiteAdminSeo<SeoInput>(
    config.seo,
    toValue(input) ?? undefined,
    resolveRoute(route.path).seo,
    toValue(pageOverride) ?? undefined,
  ))
  ${
      options.ogImage
          ? `const nuxtApp = useNuxtApp()
  const scope = getCurrentScope()
  const ownsComponentImage = ref(false)
  watch(() => resolved.value.image, (image) => {
    if (!image || typeof image !== 'object' || (scope && !scope.active)) return
    const apply = () => {
      defineOgImage(
        image.component as Parameters<typeof defineOgImage>[0],
        image.props as Parameters<typeof defineOgImage>[1],
        image.options as Parameters<typeof defineOgImage>[2],
      )
      ownsComponentImage.value = true
    }
    const withContext = () => tryUseNuxtApp() === nuxtApp ? apply() : nuxtApp.runWithContext(apply)
    if (scope) scope.run(withContext)
    else withContext()
  }, { immediate: true, deep: true })
`
          : ''
  }
  // Native OG tags use high priority and resolve lazily, so caller metadata must win by priority.
  const priority = { tagPriority: 'critical' as const }
  // Omitted images leave app-owned OG tags alone until this helper has generated its own component image.
  const clearImage = () => resolved.value.image === false${options.ogImage ? ' || (resolved.value.image === undefined && ownsComponentImage.value)' : ''}
  const imageUrl = () => typeof resolved.value.image === 'string' ? resolved.value.image : clearImage() ? null : undefined
  const clearImageDetails = () => typeof resolved.value.image === 'string' || clearImage() ? null : undefined
  ${
      options.seo === false
          ? ''
          : `const headOptions = headPriority ? { tagPriority: headPriority } : {}
  useSeoMeta({ title: () => resolved.value.title, description: () => resolved.value.description }, headOptions)`
  }
  useSeoMeta({
    ${options.seo === false ? '' : 'robots: () => resolved.value.robots,'}
    ogTitle: () => resolved.value.title,
    ogDescription: () => resolved.value.description,
    twitterTitle: () => resolved.value.title,
    twitterDescription: () => resolved.value.description,
    twitterCard: () => resolved.value.twitterCard ?? 'summary_large_image',
    ogType: () => resolved.value.type ?? 'website',
    ogImage: imageUrl,
    twitterImage: imageUrl,
    ogImageType: clearImageDetails,
    ogImageWidth: clearImageDetails,
    ogImageHeight: clearImageDetails,
    ogImageAlt: clearImageDetails,
    ogImageSecureUrl: clearImageDetails,
    twitterImageAlt: clearImageDetails,
  }, priority)
  ${
      options.seo === false
          ? ''
          : `useHead(() => ({ titleTemplate: resolved.value.titleTemplate, link: [
    ...(resolved.value.canonical ? [{ rel: 'canonical' as const, href: new URL(resolved.value.canonical, origin).href }] : []),
    ...(resolved.value.alternates ?? []).map(({ locale, path }) => ({ rel: 'alternate' as const, hreflang: locale, href: new URL(path, origin).href })),
  ] }), headOptions)`
  }
}

`
