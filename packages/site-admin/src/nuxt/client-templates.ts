import { normalize } from 'pathe'

export interface SiteAdminClientTemplateOptions {
    basePath: string
    managementBase: string
    i18n?: boolean
    origin?: string
}

/** App-side templates deliberately do not import the server's config module. */
export const siteAdminNuxtClientTemplate = (
    options: SiteAdminClientTemplateOptions,
): string => `import { createSiteAdminClient, createSiteAdminManagementClient, SiteAdminClientError } from '@liria24/site-admin/client'
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

export const siteAdminPublicClientOptions = (): SiteAdminClientOptions => ({
  basePath: ${JSON.stringify(options.basePath)},
  origin: ${options.origin ? JSON.stringify(options.origin) : 'useRequestURL().origin'},
  ${options.origin ? '' : 'fetch: useLocalFetch(),'}
})

export const useSiteAdminClient = (): SiteAdminClient => createSiteAdminClient(siteAdminPublicClientOptions())

export const siteAdminManagementClientOptions = (): SiteAdminManagementClientOptions => ({
  basePath: ${JSON.stringify(options.managementBase)},
  origin: useRequestURL().origin,
  fetch: useLocalFetch(),
})

export const useSiteAdminManagementClient = (): SiteAdminManagementClient =>
  createSiteAdminManagementClient(siteAdminManagementClientOptions())

export const useSiteAdminRoute = () => useState<PublicRouteResult | null>('site-admin-route', () => null)

${siteAdminNuxtPublicDataTemplate(options)}
`

const publicDataOverloads = (kind: 'Entry' | 'List'): string => {
    const response = kind === 'Entry' ? 'SiteAdminPublicModels[Name] | null' : 'SiteAdminPublicModels[Name][]'
    const slug = kind === 'Entry' ? ', slugOrId: MaybeRefOrGetter<string>' : ''
    return ['WithTransform', '']
        .flatMap((transform) =>
            ['undefined', 'DataT'].map(
                (defaultType) =>
                    `export function useSiteAdmin${kind}<Name extends PublicModelName, ErrorData = unknown, DataT = ${response}, PickKeys extends KeysOf<DataT> = KeysOf<DataT>, DefaultT = ${defaultType}>(model: Name${slug}, options${transform ? '' : '?'}: AsyncDataOptions${transform}<${response}, DataT, PickKeys, DefaultT> & SiteAdminLocaleOptions): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>`,
            ),
        )
        .join('\n')
}

/** Native factory options and return values are forwarded without a second cache or watch layer. */
const siteAdminNuxtPublicDataTemplate = (
    options: SiteAdminClientTemplateOptions,
): string => `import { createUseAsyncData } from '#app/composables/asyncData'
import type { AsyncData, AsyncDataOptions, AsyncDataOptionsWithTransform, KeysOf, PickFrom } from '#app/composables/asyncData'
import type { NuxtError } from '#app'
import type { SiteAdminPublicModels } from '@liria24/site-admin/client'
import type { SiteAdminIssue } from '@liria24/site-admin'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
${options.i18n ? "import { useNuxtApp } from '#imports'" : ''}

type PublicModelName = Extract<keyof SiteAdminPublicModels, string>
type SiteAdminAsyncDataError<ErrorData> = ErrorData extends Error | NuxtError ? ErrorData : NuxtError<ErrorData>
export interface SiteAdminLocaleOptions {
  locale?: MaybeRefOrGetter<string | undefined>
}

// Nuxt's factory macro must remain an exported top-level declaration.
export const siteAdminAsyncData = createUseAsyncData()

const useSiteAdminLocale = (provided: SiteAdminLocaleOptions['locale']) => {
  ${options.i18n ? 'const i18n = useNuxtApp().$i18n' : ''}
  return computed(() => toValue(provided)${options.i18n ? ' ?? toValue(i18n?.locale)' : ''})
}

const siteAdminDataKey = (connection: SiteAdminClientOptions, operation: 'entry' | 'list', model: string, slug: string | null, locale: string | undefined): string =>
  'site-admin:' + JSON.stringify([connection.origin ?? 'same-origin', connection.basePath ?? ${JSON.stringify(options.basePath)}, operation, model, slug, locale ?? null])

${publicDataOverloads('Entry')}
export function useSiteAdminEntry(model: PublicModelName, slugOrId: MaybeRefOrGetter<string>, options: AsyncDataOptions<SiteAdminPublicModels[PublicModelName] | null> & SiteAdminLocaleOptions = {}) {
  const clientOptions = siteAdminPublicClientOptions()
  const client = createSiteAdminClient(clientOptions)
  const locale = useSiteAdminLocale(options.locale)
  const key = computed(() => siteAdminDataKey(clientOptions, 'entry', model, toValue(slugOrId), locale.value))
  const { locale: _locale, ...asyncOptions } = options
  return siteAdminAsyncData(() => key.value, (_app, { signal }) => {
    const effectiveLocale = locale.value
    return client.get(model, toValue(slugOrId), { signal, ...(effectiveLocale === undefined ? {} : { locale: effectiveLocale }) })
  }, asyncOptions)
}

${publicDataOverloads('List')}
export function useSiteAdminList(model: PublicModelName, options: AsyncDataOptions<SiteAdminPublicModels[PublicModelName][]> & SiteAdminLocaleOptions = {}) {
  const clientOptions = siteAdminPublicClientOptions()
  const client = createSiteAdminClient(clientOptions)
  const locale = useSiteAdminLocale(options.locale)
  const key = computed(() => siteAdminDataKey(clientOptions, 'list', model, null, locale.value))
  const { locale: _locale, ...asyncOptions } = options
  return siteAdminAsyncData(() => key.value, (_app, { signal }) => {
    const effectiveLocale = locale.value
    return client.list(model, { signal, ...(effectiveLocale === undefined ? {} : { locale: effectiveLocale }) })
  }, asyncOptions)
}

${siteAdminNuxtBatchTransportTemplate(options.basePath)}

${publicBatchOverloads()}
export function useSiteAdminBatch(requests: MaybeRefOrGetter<Record<string, SiteAdminBatchRequest>>, options: AsyncDataOptions<SiteAdminBatchResult<Record<string, SiteAdminBatchRequest>>> & SiteAdminLocaleOptions = {}) {
  const clientOptions = siteAdminPublicClientOptions()
  const client = createSiteAdminClient(clientOptions)
  const locale = useSiteAdminLocale(options.locale)
  const snapshot = computed(() => siteAdminSnapshotBatchRequests(toValue(requests)))
  const key = computed(() => siteAdminBatchDataKey(clientOptions, snapshot.value, locale.value))
  const { locale: _locale, ...asyncOptions } = options
  return siteAdminAsyncData(() => key.value, (_app, { signal }) =>
    siteAdminResolveBatch(client, snapshot.value, locale.value, signal), asyncOptions)
}
`

const publicBatchOverloads = (): string =>
    ['WithTransform', '']
        .flatMap((transform) =>
            ['undefined', 'DataT'].map(
                (defaultType) =>
                    `export function useSiteAdminBatch<const Requests extends Record<string, SiteAdminBatchRequest>, ErrorData = unknown, DataT = SiteAdminBatchResult<Requests>, PickKeys extends KeysOf<DataT> = KeysOf<DataT>, DefaultT = ${defaultType}>(requests: MaybeRefOrGetter<Requests>, options${transform ? '' : '?'}: AsyncDataOptions${transform}<SiteAdminBatchResult<Requests>, DataT, PickKeys, DefaultT> & SiteAdminLocaleOptions): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>`,
            ),
        )
        .join('\n')

/** Bounded list/entry dispatch helpers; aggregation is owned by one native AsyncData invocation. */
export const siteAdminNuxtBatchTransportTemplate = (
    basePath = '/api/content',
): string => `export type SiteAdminBatchRequest = {
  [Name in PublicModelName]:
    | { list: Name; entry?: never; slugOrId?: never }
    | { entry: Name; slugOrId: MaybeRefOrGetter<string>; list?: never }
}[PublicModelName]

export interface SiteAdminBatchItemError {
  code: string
  message: string
  status: number
  issues?: SiteAdminIssue[]
}
export interface SiteAdminBatchItem<Data> {
  data: Data
  error: SiteAdminBatchItemError | null
}
type SiteAdminBatchRequestData<Request> = Request extends { list: infer Name extends PublicModelName }
  ? SiteAdminPublicModels[Name][]
  : Request extends { entry: infer Name extends PublicModelName }
    ? SiteAdminPublicModels[Name] | null
    : never
export type SiteAdminBatchResult<Requests extends Record<string, SiteAdminBatchRequest>> = {
  [Name in keyof Requests]: SiteAdminBatchItem<SiteAdminBatchRequestData<Requests[Name]>>
}
type SiteAdminResolvedBatchRequest = { name: string; operation: 'list' | 'entry'; model: PublicModelName; slug: string | null }

const siteAdminSnapshotBatchRequests = (requests: Record<string, SiteAdminBatchRequest>): SiteAdminResolvedBatchRequest[] =>
  Object.keys(requests).sort().map((name) => {
    const request = requests[name]!
    return request.list !== undefined
      ? { name, operation: 'list', model: request.list, slug: null }
      : { name, operation: 'entry', model: request.entry, slug: toValue(request.slugOrId) }
  })

const siteAdminBatchDataKey = (connection: SiteAdminClientOptions, requests: readonly SiteAdminResolvedBatchRequest[], locale: string | undefined): string =>
  'site-admin:' + JSON.stringify([connection.origin ?? 'same-origin', connection.basePath ?? ${JSON.stringify(basePath)}, 'batch', locale ?? null, requests.map(({ name, operation, model, slug }) => [name, operation, model, slug])])

const siteAdminBatchItemError = (error: unknown): SiteAdminBatchItemError => error instanceof SiteAdminClientError
  ? { code: error.code, message: error.message, status: error.status,
      ...(error.issues ? { issues: error.issues.map(({ path, message }) => ({ path, message })) } : {}) }
  : { code: 'SITE_ADMIN_REQUEST_FAILED', message: error instanceof Error ? error.message : 'Request failed.', status: 0 }

const siteAdminResolveBatch = async (client: SiteAdminClient, requests: readonly SiteAdminResolvedBatchRequest[], locale: string | undefined, signal: AbortSignal): Promise<SiteAdminBatchResult<Record<string, SiteAdminBatchRequest>>> => {
  signal.throwIfAborted()
  const items = await Promise.all(requests.map(async ({ name, operation, model, slug }) => {
    try {
      const options = { signal, ...(locale === undefined ? {} : { locale }) }
      const data = operation === 'list' ? await client.list(model, options) : await client.get(model, slug!, options)
      return [name, { data, error: null }] as const
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      return [name, { data: operation === 'list' ? [] : null, error: siteAdminBatchItemError(error) }] as const
    }
  }))
  signal.throwIfAborted()
  // Every named response corresponds to the model and operation in its captured request.
  return Object.fromEntries(items) as SiteAdminBatchResult<Record<string, SiteAdminBatchRequest>>
}
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

type SiteAdminDomainConfig = ResolvedSiteAdminConfig<typeof import(${JSON.stringify(normalize(configPath))}).default, readonly [${environments.map((environment) => JSON.stringify(environment)).join(', ')}]>

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

/** Page-owned SEO stays reactive and framework integration never enters Core. */
export const siteAdminNuxtSeoTemplate = (
    options: SiteAdminSeoTemplateOptions,
): string => `import { useHead, useSeoMeta, useRoute, useRuntimeConfig, useRequestURL${options.ogImage ? ', useNuxtApp, defineOgImage' : ''} } from '#imports'
import { computed, toValue${options.ogImage ? ', getCurrentScope, ref, watch' : ''}, type MaybeRefOrGetter } from 'vue'
import { createSiteAdminRouteResolver, mergeSiteAdminSeo } from '@liria24/site-admin/seo'
import type { SiteAdminRouteRules } from '@liria24/site-admin/seo'
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

export const useSeo = (
  input: MaybeRefOrGetter<SeoInput | null | undefined> = {},
  pageOverride?: MaybeRefOrGetter<PageSeoOptions | null | undefined>,
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
    const apply = () => nuxtApp.runWithContext(() => {
      defineOgImage(
        image.component as Parameters<typeof defineOgImage>[0],
        image.props as Parameters<typeof defineOgImage>[1],
        image.options as Parameters<typeof defineOgImage>[2],
      )
      ownsComponentImage.value = true
    })
    if (scope) scope.run(apply)
    else apply()
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
  useSeoMeta({
    title: () => resolved.value.title,
    ogTitle: () => resolved.value.title,
    description: () => resolved.value.description,
    ogDescription: () => resolved.value.description,
    twitterTitle: () => resolved.value.title,
    twitterDescription: () => resolved.value.description,
    robots: () => resolved.value.robots,
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
  useHead(() => ({ titleTemplate: resolved.value.titleTemplate, link: [
    ...(resolved.value.canonical ? [{ rel: 'canonical' as const, href: new URL(resolved.value.canonical, origin).href }] : []),
    ...(resolved.value.alternates ?? []).map(({ locale, path }) => ({ rel: 'alternate' as const, hreflang: locale, href: new URL(path, origin).href })),
  ] }), priority)
}
`
