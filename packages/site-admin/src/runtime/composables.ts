import { createSiteAdminClient, createSiteAdminManagementClient, SiteAdminClientError } from '../client'
import type {
    SiteAdminClient,
    SiteAdminClientOptions,
    PublicPage,
    SiteAdminManagementClient,
    SiteAdminManagementClientOptions,
    PublicRouteResult,
} from '../client'
import { createAdminClient } from '../admin-client'
import { useRequestFetch, useRequestURL, useState, useRoute } from '#app'
import type { AsyncData, AsyncDataOptions, KeysOf, PickFrom } from '#app'
import type { NuxtApp, NuxtError } from '#app'
import type { SiteAdminPublicModels, SiteAdminPublicSummaryModels } from '../client'
import type { SiteAdminIssue } from '../index'
import type {
    SiteAdminEntry,
    SiteAdminEntryPage,
    SiteAdminFormModels,
    SiteAdminManagementModels,
    SiteAdminMutation,
} from '../client'
import { presentSiteAdminData } from '../client'
import { createSiteAdminModel, siteAdminModelError } from '../model'
import type { SiteAdminModelActions, SiteAdminModelError, SiteAdminSessionDraft } from '../model'
import type { ModelDescriptor, SiteAdminDescriptor } from '../descriptor'
import { clearNuxtData, refreshNuxtData, useNuxtApp } from '#app'
import { defineUseFetchAddon } from '#app/composables/addons'
import { hashKey } from '#app'
import type { UseFetchOptions } from '#app'
import type { AsyncDataMiddleware } from '#app'
import type { SiteAdminNamedAiActions } from '../client'
import { computed, nextTick, toValue, watch, ref, shallowRef, type Ref, type MaybeRefOrGetter } from 'vue'
import type { EntryPrepareContext } from '../model'
import { useEntryForm, type UseEntryFormOptions } from '../form'

declare module '#app' {
    interface RuntimeNuxtHooks {
        'site-admin:entry:prepare': (context: EntryPrepareContext) => void | Promise<void>
    }
}

import type { UseAsyncData } from '#app'
import type { UseFetch, UseFetchAddon } from '#app'

declare global {
    interface ImportMeta {
        server: boolean
        client: boolean
        dev: boolean
        prerender: boolean
    }
}

type AsyncDataExecuteOptions = NonNullable<Parameters<AsyncData<unknown, unknown>['execute']>[0]>
type AsyncDataOptionsWithTransform<
    ResT,
    DataT = ResT,
    PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
    DefaultT = undefined,
> = AsyncDataOptions<ResT, DataT, PickKeys, DefaultT> &
    Required<Pick<AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>, 'transform'>>

type PublicModelName = Extract<keyof SiteAdminPublicModels, string>

type SiteAdminAsyncDataError<ErrorData> = ErrorData extends Error | NuxtError ? ErrorData : NuxtError<ErrorData>

export interface SiteAdminLocaleOptions {
    locale?: MaybeRefOrGetter<string | undefined>
}

export type SiteAdminBatchRequest = {
    [Name in PublicModelName]:
        | {
              list: Name
              markdown?: 'full' | 'summary'
              page?: MaybeRefOrGetter<{ limit: number; offset: number }>
              entry?: never
              id?: never
          }
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

type SiteAdminBatchMode<Request> = Request extends { markdown: infer Mode }
    ? Mode
    : Request extends { markdown?: infer Mode }
      ? Mode | undefined
      : 'full'
type SiteAdminBatchRequestData<Request> = Request extends { list: infer Name extends PublicModelName }
    ? Request extends { page: unknown }
        ? PublicPage<SiteAdminBatchListData<Name, SiteAdminBatchMode<Request>>[number]>
        : SiteAdminBatchListData<Name, SiteAdminBatchMode<Request>>
    : Request extends { entry: infer Name extends PublicModelName }
      ? SiteAdminPublicModels[Name] | null
      : never

export type SiteAdminBatchResult<Requests extends Record<string, SiteAdminBatchRequest>> = {
    [Name in keyof Requests]: SiteAdminBatchItem<SiteAdminBatchRequestData<Requests[Name]>>
}

type SiteAdminResolvedBatchRequest = {
    name: string
    operation: 'list' | 'entry'
    model: PublicModelName
    selector: string | null
    byPath?: boolean
    markdown?: 'summary'
    page?: { limit: number; offset: number }
}

export type ManagementModelName = Extract<keyof SiteAdminFormModels, string>

type FormData<Name extends string> = Name extends ManagementModelName
    ? Extract<SiteAdminFormModels[Name], Record<string, unknown>>
    : Record<string, unknown>

type ScopedManagementClient = { connection: SiteAdminManagementClientOptions; scope: string; client: unknown }

export interface SiteAdminModelOptions extends SiteAdminLocaleOptions {
    defaultLocale?: string
    page?: Ref<number>
    pageSize?: number
    all?: boolean
    q?: MaybeRefOrGetter<string | undefined>
    authScope?: MaybeRefOrGetter<string>
    immediate?: boolean
    server?: boolean
    lazy?: boolean
}

export type SiteAdminFormOptions<Data extends Record<string, unknown>> = SiteAdminModelOptions &
    UseEntryFormOptions<Data> & {
        id?: MaybeRefOrGetter<string | null | undefined>
        instance?: MaybeRefOrGetter<string | undefined>
    }

type Handled<Actions> = {
    [Key in keyof Actions]: Actions[Key] extends (...args: infer Args) => Promise<infer Result>
        ? (...args: Args) => Promise<Result | undefined>
        : Actions[Key]
}

type SiteAdminModelResource<Name extends string, Result> = Omit<
    AsyncData<Result, SiteAdminModelError | undefined>,
    'then' | 'catch' | 'finally'
> &
    Handled<Omit<SiteAdminModelActions<FormData<Name>>, 'data' | 'status' | 'error' | 'refresh' | 'meta'>> & {
        meta: Readonly<import('../client').SiteAdminModelMeta<Name>>
        page: Ref<number>
    }

type ModelActions<Name extends string> = SiteAdminModelActions<FormData<Name>>

type SingleResource<Name extends string> = Omit<
    SiteAdminModelResource<Name, SiteAdminEntry<FormData<Name>> | null>,
    'publish' | 'schedule'
> & {
    publish: (value?: FormData<Name>) => Promise<Awaited<ReturnType<ModelActions<Name>['publish']>> | undefined>
    schedule: (
        at: Date | string,
        value?: FormData<Name>,
    ) => Promise<Awaited<ReturnType<ModelActions<Name>['schedule']>> | undefined>
}

type ListResource<Name extends string> = Omit<
    SiteAdminModelResource<Name, SiteAdminEntryPage<FormData<Name>>>,
    'save' | 'schedule' | 'restore'
> & {
    schedule: (entry: SiteAdminEntry<FormData<Name>>, at: Date | string) => ReturnType<ModelActions<Name>['schedule']>
    restore: (
        entry: SiteAdminEntry<FormData<Name>>,
        revision: string,
    ) => Promise<Awaited<ReturnType<ModelActions<Name>['restore']>> | undefined>
}

type ValidModel<Name extends string> = Name &
    (Name extends ManagementModelName ? unknown : string extends Name ? unknown : never)

type AiActionName = Extract<keyof SiteAdminNamedAiActions, string>

export type UseAiOptions<Name extends AiActionName> = Pick<
    UseFetchOptions<SiteAdminNamedAiActions[Name]['data']>,
    'immediate' | 'server' | 'lazy' | 'timeout' | 'dedupe' | 'deep'
> & {
    input: MaybeRefOrGetter<SiteAdminNamedAiActions[Name]['input']>
    authScope?: MaybeRefOrGetter<string>
}

export const siteAdminAiFetchOptions: {
    method: 'post'
    watch: false
    retry: number
    dedupe: 'defer'
    addons: UseFetchAddon<{}, Pick<AsyncData<unknown, unknown>, 'execute' | 'refresh'>>[]
} = {
    method: 'post' as const,
    watch: false as const,
    retry: 0,
    dedupe: 'defer' as const,
    addons: [
        defineUseFetchAddon({
            setup: (options) => {
                Object.assign(options, { method: 'post', watch: false, retry: 0 })
                // Nuxt normalizes non-Error reasons to AbortError; timeout/provider errors retain native error state.
                const isCancellation = (reason: unknown) => !(reason instanceof Error) || reason.name === 'AbortError'
                const abortMiddleware: AsyncDataMiddleware = async (next, { signal }) => {
                    const key = toValue(options.key)
                    // Public clear settles Nuxt 4.6's external-abort promise after transport cancellation.
                    const abort = () => {
                        if (isCancellation(signal.reason) && key) clearNuxtData(key)
                    }
                    signal.addEventListener('abort', abort, { once: true })
                    try {
                        return await next()
                    } catch (cause) {
                        if (isCancellation(cause)) throw cause
                        throw siteAdminModelError(cause)
                    } finally {
                        signal.removeEventListener('abort', abort)
                    }
                }
                options.middleware.push(abortMiddleware)
                return (asyncData) => {
                    const refresh = asyncData.refresh
                    const execute = (execution?: AsyncDataExecuteOptions): Promise<void> => {
                        if (execution?.signal?.aborted && isCancellation(execution.signal.reason)) {
                            // An already-cancelled invocation must not poison defer or cancel a healthy shared request.
                            if (asyncData.status.value !== 'pending') asyncData.clear()
                            return Promise.resolve()
                        }
                        const key = toValue(options.key)
                        const pending = refresh(execution)
                        // A synchronous status watcher can abort before middleware or promise registration.
                        if (execution?.signal?.aborted && isCancellation(execution.signal.reason) && key)
                            clearNuxtData(key)
                        return pending
                    }
                    return { execute, refresh: execute }
                }
            },
        }),
    ],
}

export interface UseContent {
    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = PublicPage<SiteAdminPublicModels[Name]>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<PublicPage<SiteAdminPublicModels[Name]>, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & {
                page: MaybeRefOrGetter<{ limit: number; offset: number }>
                markdown?: 'full'
                id?: never
                path?: never
            },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = PublicPage<SiteAdminPublicModels[Name]>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptions<PublicPage<SiteAdminPublicModels[Name]>, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & {
                page: MaybeRefOrGetter<{ limit: number; offset: number }>
                markdown?: 'full'
                id?: never
                path?: never
            },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = PublicPage<SiteAdminPublicSummaryModels[Name]>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<
            PublicPage<SiteAdminPublicSummaryModels[Name]>,
            DataT,
            PickKeys,
            DefaultT
        > &
            SiteAdminLocaleOptions & {
                page: MaybeRefOrGetter<{ limit: number; offset: number }>
                markdown: 'summary'
                id?: never
                path?: never
            },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = PublicPage<SiteAdminPublicSummaryModels[Name]>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptions<PublicPage<SiteAdminPublicSummaryModels[Name]>, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & {
                page: MaybeRefOrGetter<{ limit: number; offset: number }>
                markdown: 'summary'
                id?: never
                path?: never
            },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name] | null,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<SiteAdminPublicModels[Name] | null, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: never } & (
                | { id: MaybeRefOrGetter<string>; path?: never }
                | { path: MaybeRefOrGetter<string>; id?: never }
            ),
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name] | null,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<SiteAdminPublicModels[Name] | null, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: never } & (
                | { id: MaybeRefOrGetter<string>; path?: never }
                | { path: MaybeRefOrGetter<string>; id?: never }
            ),
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name] | null,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptions<SiteAdminPublicModels[Name] | null, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: never } & (
                | { id: MaybeRefOrGetter<string>; path?: never }
                | { path: MaybeRefOrGetter<string>; id?: never }
            ),
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name] | null,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        model: Name,
        options: AsyncDataOptions<SiteAdminPublicModels[Name] | null, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: never } & (
                | { id: MaybeRefOrGetter<string>; path?: never }
                | { path: MaybeRefOrGetter<string>; id?: never }
            ),
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicSummaryModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<SiteAdminPublicSummaryModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown: 'summary'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicSummaryModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<SiteAdminPublicSummaryModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown: 'summary'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicSummaryModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptions<SiteAdminPublicSummaryModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown: 'summary'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicSummaryModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        model: Name,
        options: AsyncDataOptions<SiteAdminPublicSummaryModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown: 'summary'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<SiteAdminPublicModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: 'full'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        model: Name,
        options: AsyncDataOptionsWithTransform<SiteAdminPublicModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: 'full'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        model: Name,
        options?: AsyncDataOptions<SiteAdminPublicModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: 'full'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        Name extends PublicModelName,
        ErrorData = unknown,
        DataT = SiteAdminPublicModels[Name][],
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        model: Name,
        options?: AsyncDataOptions<SiteAdminPublicModels[Name][], DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions & { markdown?: 'full'; id?: never; path?: never },
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        const Requests extends Record<string, SiteAdminBatchRequest>,
        ErrorData = unknown,
        DataT = SiteAdminBatchResult<Requests>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        requests: MaybeRefOrGetter<Requests>,
        options: AsyncDataOptionsWithTransform<SiteAdminBatchResult<Requests>, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions,
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        const Requests extends Record<string, SiteAdminBatchRequest>,
        ErrorData = unknown,
        DataT = SiteAdminBatchResult<Requests>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        requests: MaybeRefOrGetter<Requests>,
        options: AsyncDataOptionsWithTransform<SiteAdminBatchResult<Requests>, DataT, PickKeys, DefaultT> &
            SiteAdminLocaleOptions,
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        const Requests extends Record<string, SiteAdminBatchRequest>,
        ErrorData = unknown,
        DataT = SiteAdminBatchResult<Requests>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = undefined,
    >(
        requests: MaybeRefOrGetter<Requests>,
        options?: AsyncDataOptions<SiteAdminBatchResult<Requests>, DataT, PickKeys, DefaultT> & SiteAdminLocaleOptions,
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>

    <
        const Requests extends Record<string, SiteAdminBatchRequest>,
        ErrorData = unknown,
        DataT = SiteAdminBatchResult<Requests>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
        DefaultT = DataT,
    >(
        requests: MaybeRefOrGetter<Requests>,
        options?: AsyncDataOptions<SiteAdminBatchResult<Requests>, DataT, PickKeys, DefaultT> & SiteAdminLocaleOptions,
    ): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>
}

export const createSiteAdminComposables = (
    configuration: {
        basePath: string
        managementBase: string
        origin?: string
        i18n?: boolean
        defaultLocale?: string
        auth?: boolean
        aiActions?: boolean
    },
    siteAdminAsyncData: UseAsyncData,
    siteAdminAiFetch: UseFetch,
    getAuth?: () => { user: Ref<{ id?: string; role?: string | null } | null>; session: Ref<{ id?: string } | null> },
) => {
    const siteAdminLocalFetches = new WeakMap<
        ReturnType<typeof useNuxtApp>,
        NonNullable<SiteAdminClientOptions['fetch']>
    >()

    const useLocalFetch = (): NonNullable<SiteAdminClientOptions['fetch']> => {
        if (!import.meta.server) return globalThis.fetch
        const nuxtApp = useNuxtApp()
        const cached = siteAdminLocalFetches.get(nuxtApp)
        if (cached) return cached
        const requestFetch = import.meta.server ? useRequestFetch() : undefined
        const origin = useRequestURL().origin
        const fetch: NonNullable<SiteAdminClientOptions['fetch']> = requestFetch
            ? async (input, init) => {
                  const url = new URL(String(input), origin)
                  const method = init?.method?.toLowerCase() ?? 'get'
                  if (
                      method !== 'get' &&
                      method !== 'head' &&
                      method !== 'post' &&
                      method !== 'put' &&
                      method !== 'patch' &&
                      method !== 'delete' &&
                      method !== 'options'
                  ) {
                      throw new TypeError('Unsupported Site Admin HTTP method: ' + method)
                  }
                  let response: Response | undefined
                  await requestFetch(url.pathname + url.search, {
                      ...init,
                      method,
                      responseType: 'stream',
                      ignoreResponseError: true,
                      retry: 0,
                      onResponse: (context) => {
                          response = context.response
                      },
                  })
                  if (!response) throw new Error('Site Admin internal fetch did not return a response.')
                  return response
              }
            : globalThis.fetch
        siteAdminLocalFetches.set(nuxtApp, fetch)
        return fetch
    }

    const siteAdminPublicClientOptions = (): SiteAdminClientOptions => ({
        basePath: configuration.basePath,
        origin: configuration.origin ?? useRequestURL().origin,
        ...(configuration.origin ? {} : { fetch: useLocalFetch() }),
    })

    const siteAdminManagementClientOptions = (): SiteAdminManagementClientOptions => ({
        basePath: configuration.managementBase,
        origin: useRequestURL().origin,
        fetch: useLocalFetch(),
    })

    const useAdminClient = (): ReturnType<typeof createAdminClient<SiteAdminFormModels>> => {
        const nuxtApp = useNuxtApp()
        const scope = useSiteAdminAuthScope()
        const uiLocale = useSiteAdminLocale()
        return createAdminClient(
            createNuxtSiteAdminManagementClient<SiteAdminFormModels>(siteAdminManagementClientOptions(), scope),
            (context) => nuxtApp.runWithContext(() => nuxtApp.callHook('site-admin:entry:prepare', context)),
            () => JSON.stringify([scope.value, uiLocale.value]),
            () => uiLocale.value,
        )
    }

    const useSiteAdminRoute = () => useState<PublicRouteResult | null>('site-admin-route', () => null)

    const siteAdminAttachAsyncData = <Data>(
        keySource: MaybeRefOrGetter<string>,
        handler: (app: NuxtApp, context: { signal: AbortSignal }) => Promise<Data>,
        options: Record<string, unknown> = {},
    ) => {
        // Commit each caller's computed key in Vue's job queue before native synchronous key watchers run.
        // This prevents sibling watchers from re-entering Nuxt while its shared entry is being constructed.
        const key = shallowRef(toValue(keySource))
        watch(
            () => toValue(keySource),
            (value) => {
                key.value = value
            },
        )
        return siteAdminAsyncData<Data>(key, handler, { dedupe: 'defer', ...options })
    }

    const useSiteAdminLocale = (provided?: SiteAdminLocaleOptions['locale']) => {
        const i18n = configuration.i18n
            ? (useNuxtApp() as unknown as { $i18n?: { locale: Ref<string> } }).$i18n
            : undefined
        return computed(() => toValue(provided) ?? toValue(i18n?.locale))
    }

    const siteAdminDataKey = (
        connection: SiteAdminClientOptions,
        operation: 'entry' | 'list',
        model: string,
        selector: string | null,
        locale: string | undefined,
        markdown?: 'full' | 'summary',
        byPath = false,
    ): string =>
        'site-admin:' +
        JSON.stringify([
            connection.origin ?? 'same-origin',
            connection.basePath ?? configuration.basePath,
            operation,
            model,
            selector,
            locale ?? null,
            ...(byPath ? ['path'] : []),
            ...(markdown === 'summary' ? ['summary'] : []),
        ])

    const siteAdminSnapshotBatchRequests = (
        requests: Record<string, SiteAdminBatchRequest>,
    ): SiteAdminResolvedBatchRequest[] =>
        Object.keys(requests)
            .sort()
            .map((name) => {
                const request = requests[name]!
                return request.list !== undefined
                    ? {
                          name,
                          operation: 'list',
                          model: request.list,
                          selector: null,
                          ...(request.markdown === 'summary' ? { markdown: 'summary' as const } : {}),
                          ...(request.page ? { page: toValue(request.page) } : {}),
                      }
                    : {
                          name,
                          operation: 'entry',
                          model: request.entry,
                          selector: toValue(request.id ?? request.path!),
                          ...(request.path === undefined ? {} : { byPath: true }),
                      }
            })

    const siteAdminBatchDataKey = (
        connection: SiteAdminClientOptions,
        requests: readonly SiteAdminResolvedBatchRequest[],
        locale: string | undefined,
    ): string =>
        'site-admin:' +
        JSON.stringify([
            connection.origin ?? 'same-origin',
            connection.basePath ?? configuration.basePath,
            'batch',
            locale ?? null,
            requests.map(({ name, operation, model, selector, markdown, byPath, page }) => [
                name,
                operation,
                model,
                selector,
                ...(byPath ? ['path'] : []),
                ...(markdown ? [markdown] : []),
                ...(page ? [page] : []),
            ]),
        ])

    const siteAdminBatchItemError = (error: unknown): SiteAdminBatchItemError =>
        error instanceof SiteAdminClientError
            ? {
                  code: error.code,
                  message: error.message,
                  status: error.status,
                  ...(error.issues ? { issues: error.issues.map(({ path, message }) => ({ path, message })) } : {}),
              }
            : {
                  code: 'SITE_ADMIN_REQUEST_FAILED',
                  message: error instanceof Error ? error.message : 'Request failed.',
                  status: 0,
              }

    const siteAdminResolveBatch = async (
        client: SiteAdminClient,
        requests: readonly SiteAdminResolvedBatchRequest[],
        locale: string | undefined,
        signal: AbortSignal,
    ): Promise<SiteAdminBatchResult<Record<string, SiteAdminBatchRequest>>> => {
        signal.throwIfAborted()
        const items = await Promise.all(
            requests.map(async ({ name, operation, model, selector, markdown, byPath, page }) => {
                try {
                    const options = { signal, ...(locale === undefined ? {} : { locale }) }
                    const resolved = byPath ? await client.resolveRoute(selector!, options) : undefined
                    const data =
                        operation === 'list'
                            ? page
                                ? markdown === 'summary'
                                    ? await client.page(model, page, { ...options, markdown })
                                    : await client.page(model, page, options)
                                : markdown === 'summary'
                                  ? await client.list(model, { ...options, markdown })
                                  : await client.list(model, options)
                            : byPath
                              ? resolved?.entry?.model === model
                                  ? resolved.entry
                                  : null
                              : await client.get(model, selector!, options)
                    return [name, { data, error: null }] as const
                } catch (error) {
                    signal.throwIfAborted()
                    if (error instanceof Error && error.name === 'AbortError') throw error
                    return [
                        name,
                        {
                            data: operation === 'list' ? (page ? { items: [], total: 0, ...page } : []) : null,
                            error: siteAdminBatchItemError(error),
                        },
                    ] as const
                }
            }),
        )
        signal.throwIfAborted()
        // Every named response corresponds to the model and operation in its captured request.
        return Object.fromEntries(items) as SiteAdminBatchResult<Record<string, SiteAdminBatchRequest>>
    }

    function useContent(
        modelOrRequests: PublicModelName | MaybeRefOrGetter<Record<string, SiteAdminBatchRequest>>,
        options: AsyncDataOptions<unknown> &
            SiteAdminLocaleOptions & {
                id?: MaybeRefOrGetter<string>
                path?: MaybeRefOrGetter<string>
                markdown?: 'full' | 'summary'
                page?: MaybeRefOrGetter<{ limit: number; offset: number }>
            } = {},
    ) {
        const connection = siteAdminPublicClientOptions()
        const client = createSiteAdminClient<SiteAdminPublicModels, SiteAdminPublicSummaryModels>(connection)
        const locale = useSiteAdminLocale(options.locale)
        const { locale: _locale, markdown: _markdown, id: _id, path: _path, page: _page, ...asyncOptions } = options
        if (typeof modelOrRequests !== 'string') {
            const snapshot = computed(() => siteAdminSnapshotBatchRequests(toValue(modelOrRequests)))
            const key = computed(() => siteAdminBatchDataKey(connection, snapshot.value, locale.value))
            return siteAdminAttachAsyncData(
                () => key.value,
                (_app, { signal }) => siteAdminResolveBatch(client, snapshot.value, locale.value, signal),
                asyncOptions,
            )
        }
        const model = modelOrRequests
        if (options.id !== undefined && options.path !== undefined)
            throw new TypeError('[site-admin] Choose id or path.')
        const single = options.id !== undefined || options.path !== undefined
        const route = useSiteAdminRoute()
        const path = useRoute()
        const key = computed(() =>
            siteAdminDataKey(
                connection,
                single ? 'entry' : 'list',
                model,
                single
                    ? toValue(options.id ?? options.path!)
                    : options.page
                      ? JSON.stringify(toValue(options.page))
                      : null,
                locale.value,
                options.markdown,
                options.path !== undefined,
            ),
        )
        return siteAdminAttachAsyncData(
            () => key.value,
            async (_app, { signal }): Promise<unknown> => {
                const request = { signal, ...(locale.value === undefined ? {} : { locale: locale.value }) }
                if (!single && options.page)
                    return options.markdown === 'summary'
                        ? client.page(model, toValue(options.page), { ...request, markdown: 'summary' })
                        : client.page(model, toValue(options.page), request)
                if (!single)
                    return options.markdown === 'summary'
                        ? client.list(model, { ...request, markdown: 'summary' })
                        : client.list(model, request)
                const cachedRoute = route.value
                const entry = cachedRoute?.entry
                const selector = toValue(options.id ?? options.path!)
                // Reuse the route resolver's raw DTO before native AsyncData transform/pick.
                if (
                    cachedRoute?.path === path.path &&
                    cachedRoute?.origin === connection.origin &&
                    entry?.model === model &&
                    (options.path !== undefined ? cachedRoute.path === selector : entry.id === selector) &&
                    (locale.value === undefined || entry.locale === locale.value)
                )
                    return Promise.resolve(entry)
                if (options.path !== undefined)
                    return client
                        .resolveRoute(selector, request)
                        .then((resolved) => (resolved?.entry?.model === model ? resolved.entry : null))
                return client.get(model, selector, request)
            },
            asyncOptions,
        )
    }

    const siteAdminManagementClients = new WeakMap<ReturnType<typeof useNuxtApp>, ScopedManagementClient[]>()

    const useSiteAdminAuthScope = (
        provided?: MaybeRefOrGetter<string>,
        connection: SiteAdminManagementClientOptions = siteAdminManagementClientOptions(),
    ) => {
        const nuxtApp = useNuxtApp()
        const { user, session } = getAuth?.() ?? { user: ref(null), session: ref(null) }
        const scope = computed(
            () =>
                toValue(provided) ??
                JSON.stringify([
                    user.value?.id ?? null,
                    (user.value as { role?: string } | null)?.role ?? null,
                    session.value?.id ?? null,
                ]),
        )
        watch(
            scope,
            (_next, previous) =>
                nuxtApp.runWithContext(() => {
                    const clients = siteAdminManagementClients.get(nuxtApp)
                    if (clients)
                        siteAdminManagementClients.set(
                            nuxtApp,
                            clients.filter(
                                (item) =>
                                    !(
                                        item.scope === previous &&
                                        item.connection.origin === connection.origin &&
                                        item.connection.basePath === connection.basePath
                                    ),
                            ),
                        )
                    const drafts = useState<Record<string, SiteAdminSessionDraft>>('site-admin:form-drafts', () =>
                        Object.create(null),
                    ).value
                    for (const key of Object.keys(drafts)) {
                        try {
                            const [origin, base, auth] = JSON.parse(key.slice('site-admin-management:'.length))
                            if (origin === connection.origin && base === connection.basePath && auth === previous)
                                delete drafts[key]
                        } catch {}
                    }
                    clearNuxtData((key) => {
                        if (!key.startsWith('site-admin-management:')) return false
                        try {
                            const [origin, base, auth] = JSON.parse(key.slice('site-admin-management:'.length))
                            return origin === connection.origin && base === connection.basePath && auth === previous
                        } catch {
                            return false
                        }
                    })
                }),
            { flush: 'sync' },
        )
        return scope
    }

    const siteAdminManagementKey = (
        connection: SiteAdminManagementClientOptions,
        scope: string,
        operation: string,
        model: string | null,
        identity: unknown,
        locale?: string,
        instance?: string,
    ): string =>
        'site-admin-management:' +
        JSON.stringify([
            connection.origin ?? 'same-origin',
            connection.basePath ?? configuration.managementBase,
            scope,
            operation,
            model,
            identity,
            locale ?? null,
            ...(instance === undefined ? [] : [instance]),
        ])

    const siteAdminCachedEntryId = (data: unknown): string | undefined => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
        const id = (data as { id?: unknown }).id
        return typeof id === 'string' ? id : undefined
    }

    const siteAdminInvalidateMutation = async (
        connection: SiteAdminManagementClientOptions,
        scope: string,
        mutation: SiteAdminMutation,
    ): Promise<void> => {
        const keys: string[] = []
        // useNuxtData subscribes to AsyncData; mutation observers must only inspect serialized DTOs.
        const payload = useNuxtApp().payload.data
        clearNuxtData((key) => {
            let matches = false
            try {
                if (key.startsWith('site-admin-management:')) {
                    const [origin, base, auth, operation, model, id] = JSON.parse(
                        key.slice('site-admin-management:'.length),
                    )
                    matches =
                        origin === connection.origin &&
                        base === connection.basePath &&
                        auth === scope &&
                        ((operation === 'list' && model === mutation.model) ||
                            ((operation === 'entry' || operation === 'form-entry') &&
                                (!mutation.model || model === mutation.model) &&
                                id === mutation.id))
                } else if (key.startsWith('site-admin:')) {
                    const [origin, base, operation, model, selector] = JSON.parse(key.slice('site-admin:'.length))
                    if (origin === connection.origin && base === configuration.basePath) {
                        if (operation === 'list') matches = model === mutation.model
                        // Native transform/pick may remove identity; conservatively clear that model's unidentifiable entries.
                        else if (operation === 'entry') {
                            const cachedId = siteAdminCachedEntryId(payload[key])
                            matches =
                                model === mutation.model &&
                                (selector === mutation.id || cachedId === mutation.id || cachedId === undefined)
                        } else if (operation === 'batch') {
                            const cached = payload[key] as
                                | Record<string, { data: { id?: string } | unknown[] | null }>
                                | undefined
                            matches = (selector as Array<[string, string, string, string | null]>).some(
                                ([name, itemOperation, itemModel, id]) =>
                                    itemModel === mutation.model &&
                                    (itemOperation === 'list' ||
                                        id === mutation.id ||
                                        siteAdminCachedEntryId(cached?.[name]?.data) === mutation.id ||
                                        siteAdminCachedEntryId(cached?.[name]?.data) === undefined),
                            )
                        }
                    }
                }
            } catch {
                return false
            }
            if (matches) keys.push(key)
            return matches
        })
        if (keys.length) await refreshNuxtData(keys)
    }

    const createNuxtSiteAdminManagementClient = <
        Models extends { [Name in keyof Models]: Record<string, unknown> } = SiteAdminManagementModels,
    >(
        connection: SiteAdminManagementClientOptions,
        auth: MaybeRefOrGetter<string>,
    ) => {
        const nuxtApp = useNuxtApp()
        const scoped = (): SiteAdminManagementClient<Models> => {
            const scope = toValue(auth)
            const clients = siteAdminManagementClients.get(nuxtApp) ?? []
            const cached = clients.find(
                (item) =>
                    item.scope === scope &&
                    item.connection.origin === connection.origin &&
                    item.connection.basePath === connection.basePath &&
                    item.connection.fetch === connection.fetch &&
                    item.connection.credentials === connection.credentials,
            )
            if (cached) return cached.client as SiteAdminManagementClient<Models>
            const snapshot = { ...connection }
            const client = createSiteAdminManagementClient<Models>({
                ...snapshot,
                onMutation: (mutation) =>
                    nuxtApp.runWithContext(() => siteAdminInvalidateMutation(snapshot, scope, mutation)),
            })
            clients.push({ connection: snapshot, scope, client })
            siteAdminManagementClients.set(nuxtApp, clients)
            return client
        }
        // Capture auth per invocation, including concurrent mutations and a user change while saving.
        return new Proxy(scoped(), {
            get(_target, property) {
                const method: unknown = Reflect.get(scoped(), property)
                if (typeof method !== 'function') return method
                return (...args: unknown[]) => {
                    const scope = toValue(auth)
                    const result = (Reflect.get(scoped(), property) as (...args: unknown[]) => unknown)(...args)
                    if (!(result instanceof Promise)) return result
                    return result.then((value) => {
                        if (scope !== toValue(auth))
                            throw new DOMException('Authentication changed during the request.', 'AbortError')
                        return value
                    })
                }
            },
        })
    }

    const useSiteAdminModels = (
        connection: SiteAdminManagementClientOptions,
        auth: MaybeRefOrGetter<string>,
        immediate = true,
    ) => {
        const client = createNuxtSiteAdminManagementClient(connection, auth)
        const uiLocale = useSiteAdminLocale()
        const key = computed(() =>
            siteAdminManagementKey(connection, toValue(auth), 'models', null, null, uiLocale.value),
        )
        return siteAdminAttachAsyncData(
            () => key.value,
            (_app, { signal }) => client.models({ signal, ...(uiLocale.value ? { uiLocale: uiLocale.value } : {}) }),
            { dedupe: 'defer', immediate },
        )
    }

    const siteAdminReadModels = async (
        source: ReturnType<typeof useSiteAdminModels>,
        auth: MaybeRefOrGetter<string>,
        signal: AbortSignal,
    ): Promise<SiteAdminDescriptor> => {
        const scope = toValue(auth)
        await nextTick()
        signal.throwIfAborted()
        if (scope !== toValue(auth))
            throw new DOMException('Authentication changed while loading models.', 'AbortError')
        // A form/ID cancellation must not abort a descriptor request shared by other consumers.
        if (!source.data.value) await source.execute({ dedupe: 'defer' })
        signal.throwIfAborted()
        if (scope !== toValue(auth))
            throw new DOMException('Authentication changed while loading models.', 'AbortError')
        if (source.error.value) throw source.error.value
        if (!source.data.value)
            throw new SiteAdminClientError('SITE_ADMIN_INVALID_RESPONSE', 'Model descriptor is unavailable.', 502)
        return source.data.value
    }

    const siteAdminModelDescriptor = (source: SiteAdminDescriptor, model: string): ModelDescriptor => {
        const descriptor = Object.hasOwn(source.models, model) ? source.models[model] : undefined
        if (!descriptor)
            throw new SiteAdminClientError(
                'SITE_ADMIN_FORBIDDEN',
                '[site-admin] Form model "' + model + '" is unavailable to this actor.',
                403,
            )
        return descriptor
    }

    const useAdminEntries = <Name extends string>(model: ValidModel<Name>, options: SiteAdminModelOptions = {}) =>
        useAdminResource(model, options) as unknown as Promise<ListResource<Name>> & ListResource<Name>

    const useAdminEntry = <Name extends string>(
        model: ValidModel<Name>,
        id: MaybeRefOrGetter<string | null>,
        options: SiteAdminModelOptions = {},
    ) => useAdminResource(model, { ...options, id }) as unknown as Promise<SingleResource<Name>> & SingleResource<Name>

    const useAdminForm = <Name extends string>(
        model: ValidModel<Name>,
        options: SiteAdminFormOptions<FormData<Name>> = {},
    ) => {
        const resource = useAdminResource(
            model,
            { ...options, id: () => toValue(options.id) ?? null },
            true,
        ) as unknown as Promise<SingleResource<Name>> & SingleResource<Name>
        const editor = useEntryForm(resource, options)
        const result = {
            ...editor,
            meta: resource.meta,
            data: resource.data,
            status: resource.status,
            error: resource.error,
            refresh: resource.refresh,
            features: resource.features,
            display: resource.display,
        }
        return Object.assign(
            resource.then(() => result),
            result,
        )
    }

    function useAdminResource(
        model: string,
        options: SiteAdminModelOptions & {
            id?: MaybeRefOrGetter<string | null>
            instance?: MaybeRefOrGetter<string | undefined>
        },
        form = false,
    ) {
        const connection = siteAdminManagementClientOptions()
        const auth = useSiteAdminAuthScope(options.authScope, connection)
        const locale = useSiteAdminLocale(options.locale)
        const client = createNuxtSiteAdminManagementClient<Record<string, Record<string, unknown>>>(connection, auth)
        const modelsSource = useSiteAdminModels(connection, auth, false)
        const descriptor = computed(() =>
            modelsSource.data.value && Object.hasOwn(modelsSource.data.value.models, model)
                ? modelsSource.data.value.models[model]
                : undefined,
        )
        const single = options.id !== undefined
        const id = ref(single ? toValue(options.id!) : null)
        watch(
            [() => toValue(options.id), () => toValue(options.instance), auth],
            ([value]) => {
                id.value = value ?? null
            },
            { flush: 'sync' },
        )
        const page = options.page ?? ref(1)
        const size = options.pageSize ?? 20
        if (!Number.isSafeInteger(size) || size < 1 || size > 100)
            throw new TypeError('[site-admin] pageSize must be an integer from 1 to 100.')
        watch(
            [locale, () => toValue(options.q)],
            () => {
                page.value = 1
            },
            { flush: 'sync' },
        )
        const query = computed(() => ({
            ...(locale.value === undefined ? {} : { locale: locale.value }),
            ...(toValue(options.q) === undefined ? {} : { q: toValue(options.q)! }),
            limit: size,
            offset: (Math.max(1, page.value) - 1) * size,
        }))
        const identity = computed(() =>
            siteAdminManagementKey(
                connection,
                auth.value,
                'form',
                model,
                toValue(options.instance) === undefined
                    ? (toValue(options.id) ?? null)
                    : [toValue(options.id) ?? null, toValue(options.instance)],
                locale.value,
            ),
        )
        const key = computed(() =>
            siteAdminManagementKey(
                connection,
                auth.value,
                single ? (form ? 'form-entry' : 'entry') : 'list',
                model,
                single
                    ? id.value
                    : options.all
                      ? { locale: locale.value, q: toValue(options.q), all: true }
                      : query.value,
                locale.value,
                form ? toValue(options.instance) : undefined,
            ),
        )
        let retained: unknown
        let retainedKey: string | undefined
        const source = siteAdminAttachAsyncData(
            () => key.value,
            async (_app, { signal }) => {
                const requestedKey = key.value
                try {
                    const models = await siteAdminReadModels(modelsSource, auth, signal)
                    const modelDescriptor = siteAdminModelDescriptor(models, model)
                    const present = (entry: SiteAdminEntry) => {
                        if (entry.model !== model)
                            throw new SiteAdminClientError(
                                'SITE_ADMIN_INVALID_RESPONSE',
                                'Entry does not belong to the requested model and locale.',
                                502,
                            )
                        return { ...entry, data: presentSiteAdminData(modelDescriptor, entry.data, client.assetUrl) }
                    }
                    const result = single
                        ? id.value === null
                            ? null
                            : present(await client.getEntry(id.value, { signal }))
                        : options.all
                          ? await client
                                .listAllEntries(model, { ...query.value, limit: 100, signal })
                                .then((items) => ({
                                    items: items.map(present),
                                    total: items.length,
                                    limit: items.length,
                                    offset: 0,
                                }))
                          : await client
                                .listEntries(model, { ...query.value, signal })
                                .then((responsePage) => ({ ...responsePage, items: responsePage.items.map(present) }))
                    signal.throwIfAborted()
                    if (requestedKey === key.value) {
                        retained = result
                        retainedKey = requestedKey
                    }
                    return result
                } catch (error) {
                    throw siteAdminModelError(error)
                }
            },
            {
                immediate: options.immediate,
                server: options.server,
                lazy: options.lazy,
                dedupe: 'defer',
                default: () => (retainedKey === key.value ? retained : undefined),
            },
        )
        const nativeRefresh = source.refresh
        const refresh = async (...args: Parameters<typeof nativeRefresh>) => {
            await nextTick()
            await nativeRefresh(...args)
            const result = source.data.value
            if (!single && !options.all && result && 'items' in result) {
                const last = Math.max(1, Math.ceil(result.total / size))
                if (page.value > last) {
                    page.value = last
                    await nextTick()
                    await nativeRefresh(...args)
                }
            }
        }
        const nuxtApp = useNuxtApp()
        const core = createSiteAdminModel(
            {
                data: source.data,
                status: source.status,
                error: source.error as Ref<SiteAdminModelError | undefined>,
                refresh,
            },
            {
                model,
                descriptor,
                id,
                identity,
                locale,
                client,
                instance: options.instance,
                ...((options.defaultLocale ?? configuration.defaultLocale)
                    ? { defaultLocale: options.defaultLocale ?? configuration.defaultLocale! }
                    : {}),
                prepare: (context) =>
                    nuxtApp.runWithContext(() => nuxtApp.callHook('site-admin:entry:prepare', context)),
                drafts: useState<Record<string, SiteAdminSessionDraft>>('site-admin:form-drafts', () =>
                    Object.create(null),
                ).value,
            },
        )
        const actions = {
            ...core,
            page,
            refresh,
            ...(single
                ? {
                      publish: (value?: Record<string, unknown>) => core.publish(undefined, value),
                      schedule: (at: string, value?: Record<string, unknown>) => core.schedule(at, undefined, value),
                  }
                : {
                      schedule: (entry: SiteAdminEntry, at: Date | string) => core.schedule(at, entry),
                      restore: (entry: SiteAdminEntry, revision: string) => core.restore(revision, entry),
                  }),
        }
        for (const name of [
            'save',
            'publish',
            'schedule',
            'remove',
            'unpublish',
            'cancelSchedule',
            'reorder',
            'revisions',
            'restore',
        ] as const) {
            if (typeof actions[name] !== 'function') continue
            const run = actions[name] as (...args: unknown[]) => Promise<unknown>
            Object.assign(actions, { [name]: (...args: unknown[]) => run(...args).catch(() => undefined) })
        }
        // Both the immediate object and Nuxt's awaited object expose the same extension.
        return Object.assign(
            source.then((value) => Object.assign(value, actions)),
            source,
            actions,
        )
    }

    function useAi<Name extends AiActionName>(
        name: Name,
        options: UseAiOptions<Name>,
    ): AsyncData<SiteAdminNamedAiActions[Name]['data'] | undefined, NuxtError | undefined> {
        const { input, authScope, ...nativeOptions } = options
        const scope = useSiteAdminAuthScope(authScope)
        const body = computed(() => ({ input: JSON.parse(JSON.stringify(toValue(input))) }))
        const path = configuration.managementBase.replace(/\/$/u, '') + '/ai/actions/' + encodeURIComponent(name)
        const connection = siteAdminManagementClientOptions()
        const key = computed(() => 'site-admin-ai:' + hashKey([connection.origin, path, scope.value, body.value]))
        // Clear the previous identity before Nuxt's key watcher can carry private data forward.
        let previousScope = scope.value
        watch(
            key,
            (_next, previous) => {
                const authChanged = previousScope !== scope.value
                previousScope = scope.value
                if (authChanged) clearNuxtData(previous)
            },
            { flush: 'sync' },
        )
        return siteAdminAiFetch<SiteAdminNamedAiActions[Name]['data']>(path, { ...nativeOptions, key, body })
    }
    return {
        siteAdminResolveBatch,
        siteAdminSnapshotBatchRequests,
        siteAdminBatchDataKey,
        useContent: useContent as UseContent,
        useAi,
        siteAdminPublicClientOptions,
        siteAdminManagementClientOptions,
        useAdminClient,
        useSiteAdminRoute,
        siteAdminAttachAsyncData,
        useSiteAdminAuthScope,
        siteAdminManagementKey,
        createNuxtSiteAdminManagementClient,
        useSiteAdminModels,
        siteAdminReadModels,
        useAdminEntries,
        useAdminEntry,
        useAdminForm,
    }
}
