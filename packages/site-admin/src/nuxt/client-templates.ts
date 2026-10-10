import { normalize } from 'pathe'
import { siteAdminNuxtManagementDataTemplate } from './management-template'
import { siteAdminNuxtAiTemplate } from './ai-template'

export interface SiteAdminClientTemplateOptions {
    basePath: string
    managementBase: string
    i18n?: boolean
    origin?: string
    auth?: boolean
    aiActions?: boolean
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
  createNuxtSiteAdminManagementClient(siteAdminManagementClientOptions(), useSiteAdminAuthScope())

export const useSiteAdminRoute = () => useState<PublicRouteResult | null>('site-admin-route', () => null)

${siteAdminNuxtPublicDataTemplate(options)}
${siteAdminNuxtManagementDataTemplate(options)}
${options.aiActions ? siteAdminNuxtAiTemplate(options) : ''}
`

const publicDataOverloads = (kind: 'Entry' | 'List', summary = false): string => {
    const response =
        kind === 'Entry'
            ? 'SiteAdminPublicModels[Name] | null'
            : summary
              ? 'SiteAdminPublicSummaryModels[Name][]'
              : 'SiteAdminPublicModels[Name][]'
    const slug = kind === 'Entry' ? ', slugOrId: MaybeRefOrGetter<string>' : ''
    const mode = kind === 'List' ? (summary ? " & { markdown: 'summary' }" : " & { markdown?: 'full' }") : ''
    return ['WithTransform', '']
        .flatMap((transform) =>
            ['undefined', 'DataT'].map(
                (defaultType) =>
                    `export function useSiteAdmin${kind}<Name extends PublicModelName${summary ? ' & keyof SiteAdminPublicSummaryModels' : ''}, ErrorData = unknown, DataT = ${response}, PickKeys extends KeysOf<DataT> = KeysOf<DataT>, DefaultT = ${defaultType}>(model: Name${slug}, options${transform || summary ? '' : '?'}: AsyncDataOptions${transform}<${response}, DataT, PickKeys, DefaultT> & SiteAdminLocaleOptions${mode}): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>`,
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
import type { SiteAdminPublicModels, SiteAdminPublicSummaryModels } from '@liria24/site-admin/client'
import type { SiteAdminIssue } from '@liria24/site-admin'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'

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

const siteAdminDataKey = (connection: SiteAdminClientOptions, operation: 'entry' | 'list', model: string, slug: string | null, locale: string | undefined, markdown?: 'full' | 'summary'): string =>
  'site-admin:' + JSON.stringify([connection.origin ?? 'same-origin', connection.basePath ?? ${JSON.stringify(options.basePath)}, operation, model, slug, locale ?? null, ...(markdown === 'summary' ? ['summary'] : [])])

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

${publicDataOverloads('List', true)}
${publicDataOverloads('List')}
export function useSiteAdminList(model: PublicModelName, options: AsyncDataOptions<SiteAdminPublicModels[PublicModelName][] | SiteAdminPublicSummaryModels[keyof SiteAdminPublicSummaryModels][]> & SiteAdminLocaleOptions & { markdown?: 'full' | 'summary' } = {}) {
  const clientOptions = siteAdminPublicClientOptions()
  const client = createSiteAdminClient<SiteAdminPublicModels, SiteAdminPublicSummaryModels>(clientOptions)
  const locale = useSiteAdminLocale(options.locale)
  const key = computed(() => siteAdminDataKey(clientOptions, 'list', model, null, locale.value, options.markdown))
  const { locale: _locale, markdown: _markdown, ...asyncOptions } = options
  return siteAdminAsyncData(() => key.value, (_app, { signal }): Promise<SiteAdminPublicModels[PublicModelName][] | SiteAdminPublicSummaryModels[keyof SiteAdminPublicSummaryModels][]> => {
    const effectiveLocale = locale.value
    const request = { signal, ...(effectiveLocale === undefined ? {} : { locale: effectiveLocale }) }
    if (options.markdown === 'summary') return client.list<PublicModelName & keyof SiteAdminPublicSummaryModels>(model, { ...request, markdown: 'summary' })
    return client.list<PublicModelName>(model, { ...request, markdown: 'full' })
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
    | { list: Name; markdown?: 'full' | 'summary'; entry?: never; slugOrId?: never }
    | { entry: Name; slugOrId: MaybeRefOrGetter<string>; list?: never; markdown?: never }
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
type SiteAdminBatchListData<Name extends PublicModelName, Mode> = Mode extends 'summary'
  ? SiteAdminPublicSummaryModels[Name & keyof SiteAdminPublicSummaryModels][]
  : SiteAdminPublicModels[Name][]
type SiteAdminBatchRequestData<Request> = Request extends { list: infer Name extends PublicModelName }
  ? SiteAdminBatchListData<Name, Request extends { markdown: infer Mode } ? Mode : Request extends { markdown?: infer Mode } ? Mode | undefined : 'full'>
  : Request extends { entry: infer Name extends PublicModelName }
    ? SiteAdminPublicModels[Name] | null
    : never
export type SiteAdminBatchResult<Requests extends Record<string, SiteAdminBatchRequest>> = {
  [Name in keyof Requests]: SiteAdminBatchItem<SiteAdminBatchRequestData<Requests[Name]>>
}
type SiteAdminResolvedBatchRequest = { name: string; operation: 'list' | 'entry'; model: PublicModelName; slug: string | null; markdown?: 'summary' }

const siteAdminSnapshotBatchRequests = (requests: Record<string, SiteAdminBatchRequest>): SiteAdminResolvedBatchRequest[] =>
  Object.keys(requests).sort().map((name) => {
    const request = requests[name]!
    return request.list !== undefined
      ? { name, operation: 'list', model: request.list, slug: null, ...(request.markdown === 'summary' ? { markdown: 'summary' as const } : {}) }
      : { name, operation: 'entry', model: request.entry, slug: toValue(request.slugOrId) }
  })

const siteAdminBatchDataKey = (connection: SiteAdminClientOptions, requests: readonly SiteAdminResolvedBatchRequest[], locale: string | undefined): string =>
  'site-admin:' + JSON.stringify([connection.origin ?? 'same-origin', connection.basePath ?? ${JSON.stringify(basePath)}, 'batch', locale ?? null, requests.map(({ name, operation, model, slug, markdown }) => [name, operation, model, slug, ...(markdown ? [markdown] : [])])])

const siteAdminBatchItemError = (error: unknown): SiteAdminBatchItemError => error instanceof SiteAdminClientError
  ? { code: error.code, message: error.message, status: error.status,
      ...(error.issues ? { issues: error.issues.map(({ path, message }) => ({ path, message })) } : {}) }
  : { code: 'SITE_ADMIN_REQUEST_FAILED', message: error instanceof Error ? error.message : 'Request failed.', status: 0 }

const siteAdminResolveBatch = async (client: SiteAdminClient, requests: readonly SiteAdminResolvedBatchRequest[], locale: string | undefined, signal: AbortSignal): Promise<SiteAdminBatchResult<Record<string, SiteAdminBatchRequest>>> => {
  signal.throwIfAborted()
  const items = await Promise.all(requests.map(async ({ name, operation, model, slug, markdown }) => {
    try {
      const options = { signal, ...(locale === undefined ? {} : { locale }) }
      const data = operation === 'list' ? markdown === 'summary' ? await client.list(model, { ...options, markdown }) : await client.list(model, options) : await client.get(model, slug!, options)
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
import type { UseSiteAdminFormOptions, SiteAdminFormActionNames } from '@liria24/site-admin/form'
import type { SiteAdminFormModels, SiteAdminManagementModels, SiteAdminEntry } from '@liria24/site-admin/client'
import { SiteAdminClientError } from '@liria24/site-admin/client'
import { siteAdminManagementClientOptions, createNuxtSiteAdminManagementClient, useSiteAdminAuthScope, useSiteAdminModels, siteAdminAsyncData, siteAdminManagementKey } from '#build/site-admin/client'
import { useNuxtApp, useState } from '#imports'
import * as Vue from 'vue'

type ModelName = Extract<keyof SiteAdminFormModels, string>
type ModelData<Name extends ModelName> = Extract<SiteAdminFormModels[Name], Record<string, unknown>>
type NuxtFormOptions<Data extends Record<string, unknown>, EntryData = Record<string, unknown>> = Omit<UseSiteAdminFormOptions<Data>, 'descriptor' | 'modelName' | 'entry' | 'id' | 'drafts' | 'client' | 'presentation' | 'initialEntry' | 'loadDescriptor' | 'loadEntry'> &
  ({ entry?: SiteAdminEntry<EntryData>; id?: never } | { id?: Vue.MaybeRefOrGetter<string | null | undefined>; entry?: never })

export function useSiteAdminForm<Name extends ModelName & keyof SiteAdminManagementModels>(modelName: Name, options?: NuxtFormOptions<ModelData<Name>, SiteAdminManagementModels[Name]>): Promise<ReturnType<typeof createForm<ModelData<Name>, SiteAdminFormActionNames<Extract<SiteAdminManagementModels[Name], Record<string, unknown>>>, Extract<SiteAdminManagementModels[Name], Record<string, unknown>>>>>
export function useSiteAdminForm<Data extends Record<string, unknown>>(options: UseSiteAdminFormOptions<Data>): ReturnType<typeof createForm<Data>>
export function useSiteAdminForm(modelOrOptions: string | UseSiteAdminFormOptions<Record<string, unknown>>, options: NuxtFormOptions<Record<string, unknown>> = {}) {
  const defaultConnection = siteAdminManagementClientOptions()
  const requestOptions = { ...defaultConnection, ...(options.managementBase ? { basePath: options.managementBase } : {}), ...(options.origin ? { origin: options.origin } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) }
  const defaults = {
    managementBase: requestOptions.basePath!,
    origin: requestOptions.origin!,
    ...(import.meta.server ? { fetch: requestOptions.fetch! } : {}),
  }
  if (typeof modelOrOptions !== 'string') {
    const connection = { ...requestOptions, ...(modelOrOptions.managementBase ? { basePath: modelOrOptions.managementBase } : {}), ...(modelOrOptions.origin ? { origin: modelOrOptions.origin } : {}), ...(modelOrOptions.fetch ? { fetch: modelOrOptions.fetch } : {}) }
    return createForm({ ...defaults, ...modelOrOptions, ...('slug' in modelOrOptions ? { get slug() { return modelOrOptions.slug } } : {}), client: modelOrOptions.client ?? createNuxtSiteAdminManagementClient<Record<string, Record<string, unknown>>>(connection, useSiteAdminAuthScope(modelOrOptions.authScope, connection)) })
  }
  const nuxtApp = useNuxtApp()
  const auth = useSiteAdminAuthScope(options.authScope, requestOptions)
  const management = createNuxtSiteAdminManagementClient<Record<string, Record<string, unknown>>>(requestOptions, auth)
  const drafts = useState<Record<string, import('@liria24/site-admin/form').SiteAdminSessionDraft>>('site-admin:form-drafts', () => Object.create(null)).value
  const modelsSource = useSiteAdminModels(requestOptions, auth)
  const id = () => options.entry?.id ?? Vue.toValue(options.id) ?? null
  const readId = Vue.ref(id())
  Vue.watch(id, (value) => { readId.value = value }, { flush: 'sync' })
  const key = Vue.computed(() => siteAdminManagementKey(requestOptions, auth.value, 'form-entry', modelOrOptions, readId.value, Vue.toValue(options.locale)))
  // Dedicated raw source: transform/pick/default options cannot alter form initialization.
  const entrySource = options.entry ? undefined : siteAdminAsyncData(() => key.value, async (_app, { signal }) => ({ entry: readId.value === null ? null : await management.getEntry(readId.value, { signal }) }))
  // Vue's native async-setup helper is exported at runtime but omitted from its public declarations.
  const withAsyncContext = (Vue as typeof Vue & {
    withAsyncContext?: <Value>(callback: () => Promise<Value>) => [Promise<Value>, () => void]
  }).withAsyncContext
  if (!withAsyncContext || !Vue.getCurrentInstance()) {
    throw new Error('[site-admin] Await string-model forms during a Vue component setup with async-context support.')
  }
  const [pending, restore] = withAsyncContext(async () => {
    await Promise.all([modelsSource, entrySource])
    if (modelsSource.error.value) throw modelsSource.error.value
    if (entrySource?.error.value) throw entrySource.error.value
    return modelsSource.data.value!
  })
  return pending.then(({ models }) => {
    restore()
    const descriptor = Object.hasOwn(models, modelOrOptions) ? models[modelOrOptions] : undefined
    if (!descriptor) throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', '[site-admin] Form model "' + modelOrOptions + '" is unavailable to this actor.', 403)
    const controller = createForm({ ...defaults, ...options, ...('slug' in options ? { get slug() { return options.slug } } : {}), descriptor, modelName: modelOrOptions, authScope: auth, drafts, client: management, presentation: true,
      ...(entrySource?.data.value?.entry ? { initialEntry: entrySource.data.value.entry } : {}),
      loadDescriptor: async (signal) => {
        await Vue.nextTick()
        signal.throwIfAborted()
        if (!modelsSource.data.value) await modelsSource.execute({ signal, dedupe: 'defer' })
        signal.throwIfAborted()
        if (modelsSource.error.value) throw modelsSource.error.value
        const source = modelsSource.data.value!
        const current = Object.hasOwn(source.models, modelOrOptions) ? source.models[modelOrOptions] : undefined
        if (!current) throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', '[site-admin] Form model is unavailable to this actor.', 403)
        return current
      },
      ...(entrySource ? { loadEntry: async (requestedId: string, signal: AbortSignal) => {
        signal.throwIfAborted()
        readId.value = requestedId
        await Vue.nextTick()
        signal.throwIfAborted()
        await entrySource.execute({ signal, dedupe: 'defer' })
        signal.throwIfAborted()
        if (entrySource.error.value) throw entrySource.error.value
        const entry = entrySource.data.value?.entry
        if (!entry || entry.id !== requestedId) throw new SiteAdminClientError('SITE_ADMIN_INVALID_RESPONSE', 'Entry source changed while loading.', 502)
        return entry
      } } : {}),
    })
    Vue.watch(controller.entryId, (value) => { readId.value = value }, { flush: 'sync' })
    const stop = nuxtApp.hook('app:data:refresh', async (keys?: string[]) => {
      const currentKey = siteAdminManagementKey(requestOptions, auth.value, 'form-entry', modelOrOptions, controller.entryId.value, Vue.toValue(options.locale))
      if (!keys || keys.includes(currentKey)) await controller.refresh()
    })
    Vue.onScopeDispose(stop)
    return controller
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
import type { InferSiteAdminModels, InferSiteAdminFormModels, InferSiteAdminNamedAiActions, InferSiteAdminPublicModels, ResolvedSiteAdminConfig } from '@liria24/site-admin'

type SiteAdminDomainConfig = ResolvedSiteAdminConfig<typeof import(${JSON.stringify(normalize(configPath))}).default, readonly [${environments.map((environment) => JSON.stringify(environment)).join(', ')}]>

declare module '@liria24/site-admin/client' {
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
): string => `import { useSeoMeta, useRoute, useRuntimeConfig, useRequestURL${options.seo === false ? '' : ', useHead'}${options.ogImage ? ', useNuxtApp, defineOgImage' : ''} } from '#imports'
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
    ${options.seo === false ? '' : 'title: () => resolved.value.title, description: () => resolved.value.description, robots: () => resolved.value.robots,'}
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
  ] }), priority)`
  }
}
`
