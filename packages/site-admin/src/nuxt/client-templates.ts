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
export const { useContent, ${options.aiActions ? 'useAi, ' : ''}siteAdminPublicClientOptions, siteAdminManagementClientOptions, useAdminClient, useSiteAdminRoute, siteAdminAttachAsyncData, useSiteAdminAuthScope, siteAdminManagementKey, createNuxtSiteAdminManagementClient, useSiteAdminModels, siteAdminReadModels, useAdminEntries, useAdminEntry, useAdminForm } = createSiteAdminComposables(${JSON.stringify(options)}, siteAdminAsyncData, siteAdminAiFetch${options.auth ? ', useUserSession' : ''})
export type { UseAiOptions, SiteAdminModelOptions, SiteAdminFormOptions, SiteAdminLocaleOptions, SiteAdminBatchRequest, SiteAdminBatchResult } from '@liria24/site-admin/internal/runtime/composables'
`

/** A config path is used only by TypeScript; the app never loads its runtime code. */
export const siteAdminNuxtModelTypes = (
    configPath: string,
    environments: readonly string[] = [],
): string => `import '@liria24/site-admin/internal/client'
import type { InferSiteAdminModels, InferSiteAdminMeta, InferSiteAdminFormModels, InferSiteAdminNamedAiActions, InferSiteAdminPublicModels, ResolvedSiteAdminConfig } from '@liria24/site-admin'
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
    modelMeta: InferSiteAdminMeta<SiteAdminDomainConfig>
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

/** Only native OG component types and the optional import are generated. */
export const siteAdminNuxtSeoTemplate = (
    options: SiteAdminSeoTemplateOptions,
): string => `import { createSeoMetadata } from '@liria24/site-admin/internal/runtime/seo'
${options.ogImage ? "import { defineOgImage } from '#imports'" : ''}
${
    options.ogImage
        ? `type NativeOgImage = {
  component: Parameters<typeof defineOgImage>[0]
  props?: Parameters<typeof defineOgImage>[1]
  options?: Parameters<typeof defineOgImage>[2]
}`
        : ''
}
export const useSiteAdminSeoMetadata = createSeoMetadata${options.ogImage ? '<NativeOgImage>' : ''}({
  seo: ${options.seo !== false},
  ${options.ogImage ? 'generateImage: image => { defineOgImage(image.component, image.props, image.options) },' : ''}
})
`
