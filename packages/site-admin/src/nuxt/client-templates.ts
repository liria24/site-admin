export interface SiteAdminClientTemplateOptions {
    basePath: string
    managementBase: string
    origin?: string
}

/** App-side templates deliberately do not import the server's config module. */
export const siteAdminNuxtClientTemplate = (
    options: SiteAdminClientTemplateOptions,
): string => `import { createSiteAdminClient, createSiteAdminManagementClient } from '@liria24/site-admin/client'
import type { SiteAdminClient, SiteAdminClientOptions, SiteAdminManagementClient, SiteAdminManagementClientOptions, PublicRouteResult } from '@liria24/site-admin/client'
import { useRequestFetch, useRequestURL, useState } from '#imports'

const useLocalFetch = (): NonNullable<SiteAdminClientOptions['fetch']> => {
  const requestFetch = import.meta.server ? useRequestFetch() : undefined
  const origin = useRequestURL().origin
  return requestFetch ? async (input, init) => {
    const url = new URL(String(input), origin)
    const method = init?.method?.toLowerCase() ?? 'get'
    if (method !== 'get' && method !== 'head' && method !== 'post' && method !== 'put' && method !== 'patch' && method !== 'delete' && method !== 'options') {
      throw new TypeError('Unsupported Site Admin HTTP method: ' + method)
    }
    let response: Response | undefined
    await requestFetch(url.pathname + url.search, {
      ...init, method, responseType: 'stream', ignoreResponseError: true, retry: 0,
      onResponse: (context) => { response = context.response },
    })
    if (!response) throw new Error('Site Admin internal fetch did not return a response.')
    return response
  } : globalThis.fetch
}

export const useSiteAdminClient = (): SiteAdminClient => createSiteAdminClient({
  basePath: ${JSON.stringify(options.basePath)},
  origin: ${options.origin ? JSON.stringify(options.origin) : 'useRequestURL().origin'},
  ${options.origin ? '' : 'fetch: useLocalFetch(),'}
})

export const siteAdminManagementClientOptions = (): SiteAdminManagementClientOptions => ({
  basePath: ${JSON.stringify(options.managementBase)},
  origin: useRequestURL().origin,
  fetch: useLocalFetch(),
})

export const useSiteAdminManagementClient = (): SiteAdminManagementClient =>
  createSiteAdminManagementClient(siteAdminManagementClientOptions())

export const useSiteAdminRoute = () => useState<PublicRouteResult | null>('site-admin-route', () => null)
`

/** Emit only if the consumer has installed the optional TanStack form peer. */
export const siteAdminNuxtFormTemplate =
    (): string => `import { useSiteAdminForm as createForm } from '@liria24/site-admin/form'
import type { UseSiteAdminFormOptions } from '@liria24/site-admin/form'
import type { SiteAdminManagementModels } from '@liria24/site-admin/client'
import { siteAdminManagementClientOptions, useSiteAdminManagementClient } from '#build/site-admin/client'
import { useNuxtApp } from '#imports'
import * as Vue from 'vue'

type ModelName = Extract<keyof SiteAdminManagementModels, string>
type ModelData<Name extends ModelName> = Extract<SiteAdminManagementModels[Name], Record<string, unknown>>
type NuxtFormOptions<Data extends Record<string, unknown>> = Omit<UseSiteAdminFormOptions<Data>, 'descriptor' | 'modelName'>

export function useSiteAdminForm<Name extends ModelName>(modelName: Name, options?: NuxtFormOptions<ModelData<Name>>): Promise<ReturnType<typeof createForm<ModelData<Name>>>>
export function useSiteAdminForm<Data extends Record<string, unknown>>(options: UseSiteAdminFormOptions<Data>): ReturnType<typeof createForm<Data>>
export function useSiteAdminForm(modelOrOptions: string | UseSiteAdminFormOptions<Record<string, unknown>>, options: NuxtFormOptions<Record<string, unknown>> = {}) {
  const requestOptions = siteAdminManagementClientOptions()
  const defaults = {
    managementBase: requestOptions.basePath!,
    origin: requestOptions.origin!,
    ...(import.meta.server ? { fetch: requestOptions.fetch! } : {}),
  }
  if (typeof modelOrOptions !== 'string') return createForm({ ...defaults, ...modelOrOptions })
  const nuxtApp = useNuxtApp()
  const management = useSiteAdminManagementClient()
  // Vue's native async-setup helper is exported at runtime but omitted from its public declarations.
  const withAsyncContext = (Vue as typeof Vue & {
    withAsyncContext?: <Value>(callback: () => Promise<Value>) => [Promise<Value>, () => void]
  }).withAsyncContext
  if (!withAsyncContext || !Vue.getCurrentInstance()) {
    throw new Error('[site-admin] Await string-model forms during a Vue component setup with async-context support.')
  }
  const [pending, restore] = withAsyncContext(() => management.models())
  return pending.then(({ models }) => {
    restore()
    const descriptor = Object.hasOwn(models, modelOrOptions) ? models[modelOrOptions] : undefined
    if (!descriptor) throw new Error('[site-admin] Form model "' + modelOrOptions + '" is unavailable to this actor.')
    return nuxtApp.runWithContext(() => createForm({ ...defaults, ...options, descriptor, modelName: modelOrOptions }))
  }, (error: unknown) => {
    restore()
    throw error
  })
}
`

/** A config path is used only by TypeScript; the app never loads its runtime code. */
export const siteAdminNuxtModelTypes = (
    configPath: string,
    environments: readonly string[] = [],
): string => `import '@liria24/site-admin/client'
import type { InferSiteAdminModels, InferSiteAdminPublicModels, ResolvedSiteAdminConfig } from '@liria24/site-admin'

type SiteAdminDomainConfig = ResolvedSiteAdminConfig<typeof import(${JSON.stringify(configPath.replaceAll('\\', '/'))}).default, readonly [${environments.map((environment) => JSON.stringify(environment)).join(', ')}]>

declare module '@liria24/site-admin/client' {
  interface SiteAdminClientRegistry {
    managementModels: InferSiteAdminModels<SiteAdminDomainConfig>
    publicModels: InferSiteAdminPublicModels<SiteAdminDomainConfig>
  }
}
export {}
`

export interface SiteAdminSeoTemplateOptions {
    ogImage: boolean
}

/** Page-owned SEO convenience stays in Nuxt and never adds a framework dependency to Core. */
export const siteAdminNuxtSeoTemplate = (
    options: SiteAdminSeoTemplateOptions,
): string => `import { useHead, useSeoMeta${options.ogImage ? ', defineOgImage' : ''} } from '#imports'

${
    options.ogImage
        ? `type OgImageInput = {
  component: Parameters<typeof defineOgImage>[0]
  props?: Parameters<typeof defineOgImage>[1]
  options?: Parameters<typeof defineOgImage>[2]
}
`
        : ''
}
export interface SiteAdminSeoOptions {
  title?: string
  titleTemplate?: string
  description?: string
  image?: ${options.ogImage ? 'OgImageInput' : 'never'}
  type?: 'website' | 'article'
  twitterCard?: 'summary' | 'summary_large_image'
}

export const defineSeo = ({ title, titleTemplate, description${options.ogImage ? ', image' : ''}, type, twitterCard }: SiteAdminSeoOptions): void => {
  useSeoMeta({
    title,
    titleTemplate,
    ogTitle: title,
    description,
    ogDescription: description,
    twitterTitle: title,
    twitterDescription: description,
    twitterCard: twitterCard ?? 'summary_large_image',
  })
  useHead({ meta: [{ property: 'og:type', content: type ?? 'website' }] })
  ${options.ogImage ? 'if (image) defineOgImage(image.component, image.props, image.options)' : ''}
}
`
