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
): string => `import { createSiteAdminClient, createSiteAdminManagementClient, SiteAdminClientError } from '@liria24/site-admin/internal/client'
import type { SiteAdminClient, SiteAdminClientOptions, SiteAdminManagementClient, SiteAdminManagementClientOptions, PublicRouteResult } from '@liria24/site-admin/internal/client'
import { createAdminClient } from '@liria24/site-admin/internal/admin-client'
import { useRequestFetch, useRequestURL, useState, useRoute } from '#imports'

const siteAdminLocalFetches = new WeakMap<ReturnType<typeof useNuxtApp>, NonNullable<SiteAdminClientOptions['fetch']>>()
const useLocalFetch = (): NonNullable<SiteAdminClientOptions['fetch']> => {
  if (!import.meta.server) return globalThis.fetch
  const nuxtApp = useNuxtApp()
  const cached = siteAdminLocalFetches.get(nuxtApp)
  if (cached) return cached
  const requestFetch = import.meta.server ? useRequestFetch() : undefined
  const origin = useRequestURL().origin
  const fetch: NonNullable<SiteAdminClientOptions['fetch']> = requestFetch ? async (input, init) => {
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
  siteAdminLocalFetches.set(nuxtApp, fetch)
  return fetch
}

export const siteAdminPublicClientOptions = (): SiteAdminClientOptions => ({
  basePath: ${JSON.stringify(options.basePath)},
  origin: ${options.origin ? JSON.stringify(options.origin) : 'useRequestURL().origin'},
  ${options.origin ? '' : 'fetch: useLocalFetch(),'}
})


export const siteAdminManagementClientOptions = (): SiteAdminManagementClientOptions => ({
  basePath: ${JSON.stringify(options.managementBase)},
  origin: useRequestURL().origin,
  fetch: useLocalFetch(),
})

export const useAdminClient = () => {
  const nuxtApp = useNuxtApp()
  const scope = useSiteAdminAuthScope()
  return createAdminClient(createNuxtSiteAdminManagementClient<SiteAdminFormModels>(siteAdminManagementClientOptions(), scope), (context) => nuxtApp.runWithContext(() => nuxtApp.callHook('site-admin:entry:prepare', context)), scope)
}

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
    const selector =
        kind === 'Entry'
            ? ' & ({ id: MaybeRefOrGetter<string>; path?: never } | { path: MaybeRefOrGetter<string>; id?: never })'
            : ''
    const mode =
        kind === 'List'
            ? summary
                ? " & { markdown: 'summary'; id?: never; path?: never }"
                : " & { markdown?: 'full'; id?: never; path?: never }"
            : ' & { markdown?: never }'
    return ['WithTransform', '']
        .flatMap((transform) =>
            ['undefined', 'DataT'].map(
                (defaultType) =>
                    `export function useContent<Name extends PublicModelName${summary ? ' & keyof SiteAdminPublicSummaryModels' : ''}, ErrorData = unknown, DataT = ${response}, PickKeys extends KeysOf<DataT> = KeysOf<DataT>, DefaultT = ${defaultType}>(model: Name, options${transform || summary || kind === 'Entry' ? '' : '?'}: AsyncDataOptions${transform}<${response}, DataT, PickKeys, DefaultT> & SiteAdminLocaleOptions${mode}${selector}): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>`,
            ),
        )
        .join('\n')
}

/** One native AsyncData owns each key. Callers share that subscription instead of constructing it again. */
const siteAdminNuxtPublicDataTemplate = (
    options: SiteAdminClientTemplateOptions,
): string => `import { createUseAsyncData } from '#app/composables/asyncData'
import type { AsyncData, AsyncDataOptions, AsyncDataOptionsWithTransform, KeysOf, PickFrom } from '#app/composables/asyncData'
import type { NuxtError } from '#app'
import type { SiteAdminPublicModels, SiteAdminPublicSummaryModels } from '@liria24/site-admin/internal/client'
import type { SiteAdminIssue } from '@liria24/site-admin'
import { computed, nextTick, onScopeDispose, queuePostFlushCb, toValue, watch, type MaybeRefOrGetter } from 'vue'

type PublicModelName = Extract<keyof SiteAdminPublicModels, string>
type SiteAdminAsyncDataError<ErrorData> = ErrorData extends Error | NuxtError ? ErrorData : NuxtError<ErrorData>
export interface SiteAdminLocaleOptions {
  locale?: MaybeRefOrGetter<string | undefined>
}

// Nuxt's factory macro must remain an exported top-level declaration.
export const siteAdminAsyncData = createUseAsyncData()

type SiteAdminSharedAsyncEntry = {
  data: { value: unknown }
  pending: { value: boolean }
  error: { value: unknown }
  status: { value: string }
  execute: (opts?: { cause?: string; dedupe?: 'cancel' | 'defer' | undefined }) => Promise<unknown>
  _deps: number
  _init: boolean
  _off: () => void
  _execute?: (opts?: { cause?: string; dedupe?: 'cancel' | 'defer' }) => Promise<unknown>
  _abortController?: AbortController | undefined
}
type SiteAdminSharedNuxtApp = ReturnType<typeof useNuxtApp> & {
  _asyncData: Record<string, SiteAdminSharedAsyncEntry | undefined>
  _asyncDataPromises: Record<string, Promise<unknown> | undefined>
}

/** One native subscription per key. Further callers only attach, so Nuxt never builds the same key twice. */
export const siteAdminAttachAsyncData = (keySource: MaybeRefOrGetter<string>, handler: (nuxtApp: unknown, context: { signal: AbortSignal }) => Promise<unknown>, options: Record<string, unknown> = {}) => {
  const nuxtApp = useNuxtApp() as SiteAdminSharedNuxtApp
  const key = computed(() => toValue(keySource))
  const { watch: watchSources, ...asyncOptions } = options
  const dedupe = asyncOptions.dedupe === 'cancel' || asyncOptions.dedupe === 'defer' ? asyncOptions.dedupe : undefined
  let attached = key.value
  let manual = false
  const release = (name: string) => {
    const data = nuxtApp._asyncData[name]
    if (!data?._deps) return
    data._deps--
    if (data._deps === 0) data._off()
  }
  const existing = nuxtApp._asyncData[attached]
  const created = existing?._init ? undefined : (siteAdminAsyncData(() => key.value, handler as never, asyncOptions as never) as AsyncData<any, any>)
  if (existing?._init) {
    existing._deps++
    manual = true
    onScopeDispose(() => { if (manual) release(attached) })
    if (options.immediate !== false && existing.status.value !== 'success' && !nuxtApp._asyncDataPromises[attached]) {
      existing.execute(dedupe ? { cause: 'initial', dedupe } : { cause: 'initial' })
    }
  }
  const follow = (newKey: string, oldKey?: string) => {
    if (!manual || !newKey || newKey === attached) return true
    const next = nuxtApp._asyncData[newKey]
    if (!next?._init) return false
    next._deps++
    const previous = oldKey ? nuxtApp._asyncData[oldKey] : undefined
    const hadData = previous?.data.value !== undefined
    const wasRunning = oldKey ? nuxtApp._asyncDataPromises[oldKey] !== undefined : false
    release(attached)
    attached = newKey
    if (!nuxtApp._asyncDataPromises[newKey] && next.status.value !== 'pending' && (options.immediate !== false || hadData || wasRunning)) {
      next.execute(dedupe ? { cause: 'initial', dedupe } : { cause: 'initial' })
    }
    return true
  }
  let keyChanging = false
  if (!import.meta.server && (manual || watchSources)) watch(key, (newKey, oldKey) => {
    keyChanging = true
    queuePostFlushCb(() => { keyChanging = false })
    if (!manual || !newKey || newKey === oldKey) return
    if (follow(newKey, oldKey)) return
    queuePostFlushCb(() => {
      if (!manual) return
      const current = key.value
      if (!current || follow(current, oldKey)) return
      manual = false
      release(attached)
      attached = current
      siteAdminAsyncData(() => key.value, handler as never, asyncOptions as never)
    })
  }, { flush: 'sync' })
  if (!import.meta.server && watchSources) watch(watchSources as object, () => {
    if (keyChanging) return
    nuxtApp._asyncData[key.value]?._execute?.(dedupe ? { cause: 'watch', dedupe } : { cause: 'watch' })
  })
  const enabled = options.enabled
  if (!import.meta.server && manual && (typeof enabled === 'function' || (typeof enabled === 'object' && enabled))) watch(() => typeof enabled === 'function' ? enabled() : (enabled as { value: boolean }).value, (isEnabled) => {
    const entry = nuxtApp._asyncData[key.value]
    if (isEnabled || !entry || !nuxtApp._asyncDataPromises[key.value]) return
    entry._abortController?.abort(new DOMException("AsyncData request cancelled by \`enabled: false\`", "AbortError"))
    entry._abortController = undefined
    delete nuxtApp._asyncDataPromises[key.value]
    entry.status.value = 'idle'
  })
  if (created) return created
  const readRef = (pick: 'data' | 'pending' | 'status' | 'error') => computed({
    get: () => nuxtApp._asyncData[key.value]?.[pick]?.value,
    set: (value) => {
      const target = nuxtApp._asyncData[key.value]?.[pick]
      if (target) target.value = value
    },
  })
  const asyncReturn = {
    data: readRef('data'),
    pending: readRef('pending'),
    status: readRef('status'),
    error: readRef('error'),
    refresh: (...args: [{ cause?: string; dedupe?: 'cancel' | 'defer'; signal?: AbortSignal; cachedData?: unknown; timeout?: number }?]) => nuxtApp._asyncData[key.value]?.execute(...args) ?? Promise.resolve(),
    execute: (...args: [{ cause?: string; dedupe?: 'cancel' | 'defer'; signal?: AbortSignal; cachedData?: unknown; timeout?: number }?]) => asyncReturn.refresh(...args),
    clear: () => {
      const current = key.value
      const entry = nuxtApp._asyncData[current]
      if (entry?._abortController) {
        try { entry._abortController.abort(new DOMException('AsyncData aborted by user.', 'AbortError')) }
        finally { entry._abortController = undefined }
      }
      clearNuxtData(current)
    },
  }
  const asyncDataPromise = Promise.resolve(nuxtApp._asyncDataPromises[key.value]).then(() => asyncReturn)
  return Object.assign(asyncDataPromise, asyncReturn) as unknown as AsyncData<any, any>
}

const useSiteAdminLocale = (provided: SiteAdminLocaleOptions['locale']) => {
  ${options.i18n ? 'const i18n = useNuxtApp().$i18n' : ''}
  return computed(() => toValue(provided)${options.i18n ? ' ?? toValue(i18n?.locale)' : ''})
}

const siteAdminDataKey = (connection: SiteAdminClientOptions, operation: 'entry' | 'list', model: string, selector: string | null, locale: string | undefined, markdown?: 'full' | 'summary', byPath = false): string =>
  'site-admin:' + JSON.stringify([connection.origin ?? 'same-origin', connection.basePath ?? ${JSON.stringify(options.basePath)}, operation, model, selector, locale ?? null, ...(byPath ? ['path'] : []), ...(markdown === 'summary' ? ['summary'] : [])])

${siteAdminNuxtBatchTransportTemplate(options.basePath)}

${publicDataOverloads('Entry')}
${publicDataOverloads('List', true)}
${publicDataOverloads('List')}
${publicBatchOverloads()}
export function useContent(modelOrRequests: PublicModelName | MaybeRefOrGetter<Record<string, SiteAdminBatchRequest>>, options: AsyncDataOptions<any> & SiteAdminLocaleOptions & { id?: MaybeRefOrGetter<string>; path?: MaybeRefOrGetter<string>; markdown?: 'full' | 'summary' } = {}) {
  const connection = siteAdminPublicClientOptions()
  const client = createSiteAdminClient<SiteAdminPublicModels, SiteAdminPublicSummaryModels>(connection)
  const locale = useSiteAdminLocale(options.locale)
  const { locale: _locale, markdown: _markdown, id: _id, path: _path, ...asyncOptions } = options
  if (typeof modelOrRequests !== 'string') {
    const snapshot = computed(() => siteAdminSnapshotBatchRequests(toValue(modelOrRequests)))
    const key = computed(() => siteAdminBatchDataKey(connection, snapshot.value, locale.value))
    return siteAdminAttachAsyncData(() => key.value, (_app, { signal }) => siteAdminResolveBatch(client, snapshot.value, locale.value, signal), asyncOptions)
  }
  const model = modelOrRequests
  if (options.id !== undefined && options.path !== undefined) throw new TypeError('[site-admin] Choose id or path.')
  const single = options.id !== undefined || options.path !== undefined
  const route = useSiteAdminRoute()
  const path = useRoute()
  const key = computed(() => siteAdminDataKey(connection, single ? 'entry' : 'list', model, single ? toValue(options.id ?? options.path!) : null, locale.value, options.markdown, options.path !== undefined))
  return siteAdminAttachAsyncData(() => key.value, (_app, { signal }) => {
    const request = { signal, ...(locale.value === undefined ? {} : { locale: locale.value }) }
    if (!single) return options.markdown === 'summary' ? client.list(model, { ...request, markdown: 'summary' }) : client.list(model, request)
    const resolved = route.value
    const entry = resolved?.entry
    const selector = toValue(options.id ?? options.path!)
    // Reuse the route resolver's raw DTO before native AsyncData transform/pick.
    if (resolved?.path === path.path && resolved?.origin === connection.origin && entry?.model === model &&
        (options.path !== undefined ? resolved.path === selector : entry.id === selector) && (locale.value === undefined || entry.locale === locale.value)) return Promise.resolve(entry)
    if (options.path !== undefined) return client.resolveRoute(selector, request).then((resolved) => resolved?.entry?.model === model ? resolved.entry : null)
    return client.get(model, selector, request)
  }, asyncOptions)
}

`

const publicBatchOverloads = (): string =>
    ['WithTransform', '']
        .flatMap((transform) =>
            ['undefined', 'DataT'].map(
                (defaultType) =>
                    `export function useContent<const Requests extends Record<string, SiteAdminBatchRequest>, ErrorData = unknown, DataT = SiteAdminBatchResult<Requests>, PickKeys extends KeysOf<DataT> = KeysOf<DataT>, DefaultT = ${defaultType}>(requests: MaybeRefOrGetter<Requests>, options${transform ? '' : '?'}: AsyncDataOptions${transform}<SiteAdminBatchResult<Requests>, DataT, PickKeys, DefaultT> & SiteAdminLocaleOptions): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>`,
            ),
        )
        .join('\n')

/** Bounded list/entry dispatch helpers; aggregation is owned by one native AsyncData invocation. */
export const siteAdminNuxtBatchTransportTemplate = (
    basePath = '/api/content',
): string => `export type SiteAdminBatchRequest = {
  [Name in PublicModelName]:
    | { list: Name; markdown?: 'full' | 'summary'; entry?: never; id?: never }
    | { entry: Name; id: MaybeRefOrGetter<string>; path?: never; list?: never; markdown?: never }
    | { entry: Name; path: MaybeRefOrGetter<string>; id?: never; list?: never; markdown?: never }
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
type SiteAdminResolvedBatchRequest = { name: string; operation: 'list' | 'entry'; model: PublicModelName; selector: string | null; byPath?: boolean; markdown?: 'summary' }

const siteAdminSnapshotBatchRequests = (requests: Record<string, SiteAdminBatchRequest>): SiteAdminResolvedBatchRequest[] =>
  Object.keys(requests).sort().map((name) => {
    const request = requests[name]!
    return request.list !== undefined
      ? { name, operation: 'list', model: request.list, selector: null, ...(request.markdown === 'summary' ? { markdown: 'summary' as const } : {}) }
      : { name, operation: 'entry', model: request.entry, selector: toValue(request.id ?? request.path!), ...(request.path === undefined ? {} : { byPath: true }) }
  })

const siteAdminBatchDataKey = (connection: SiteAdminClientOptions, requests: readonly SiteAdminResolvedBatchRequest[], locale: string | undefined): string =>
  'site-admin:' + JSON.stringify([connection.origin ?? 'same-origin', connection.basePath ?? ${JSON.stringify(basePath)}, 'batch', locale ?? null, requests.map(({ name, operation, model, selector, markdown, byPath }) => [name, operation, model, selector, ...(byPath ? ['path'] : []), ...(markdown ? [markdown] : [])])])

const siteAdminBatchItemError = (error: unknown): SiteAdminBatchItemError => error instanceof SiteAdminClientError
  ? { code: error.code, message: error.message, status: error.status,
      ...(error.issues ? { issues: error.issues.map(({ path, message }) => ({ path, message })) } : {}) }
  : { code: 'SITE_ADMIN_REQUEST_FAILED', message: error instanceof Error ? error.message : 'Request failed.', status: 0 }

const siteAdminResolveBatch = async (client: SiteAdminClient, requests: readonly SiteAdminResolvedBatchRequest[], locale: string | undefined, signal: AbortSignal): Promise<SiteAdminBatchResult<Record<string, SiteAdminBatchRequest>>> => {
  signal.throwIfAborted()
  const items = await Promise.all(requests.map(async ({ name, operation, model, selector, markdown, byPath }) => {
    try {
      const options = { signal, ...(locale === undefined ? {} : { locale }) }
      const resolved = byPath ? await client.resolveRoute(selector!, options) : undefined
      const data = operation === 'list' ? markdown === 'summary' ? await client.list(model, { ...options, markdown }) : await client.list(model, options) : byPath ? resolved?.entry?.model === model ? resolved.entry : null : await client.get(model, selector!, options)
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
