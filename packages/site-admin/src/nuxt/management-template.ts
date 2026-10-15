import type { SiteAdminClientTemplateOptions } from './client-templates'

/** All cache enumeration/invalidation goes through Nuxt's public data APIs. */
export const siteAdminNuxtManagementDataTemplate = (options: SiteAdminClientTemplateOptions): string => `
import type { SiteAdminEntry, SiteAdminEntryPage, SiteAdminFormModels, SiteAdminManagementModels, SiteAdminMutation } from '@liria24/site-admin/internal/client'
import { presentSiteAdminData } from '@liria24/site-admin/internal/client'
import { createSiteAdminModel, siteAdminModelError } from '@liria24/site-admin/internal/model'
import type { SiteAdminModelActions, SiteAdminModelError, SiteAdminSessionDraft } from '@liria24/site-admin/internal/model'
import { ref, type Ref } from 'vue'
import type { ModelDescriptor, SiteAdminDescriptor } from '@liria24/site-admin/internal/descriptor'
import { clearNuxtData, refreshNuxtData, useNuxtApp${options.auth ? ', useUserSession' : ''} } from '#imports'

export type ManagementModelName = Extract<keyof SiteAdminFormModels, string>
type FormData<Name extends string> = Name extends ManagementModelName ? Extract<SiteAdminFormModels[Name], Record<string, unknown>> : Record<string, unknown>
type ScopedManagementClient = { connection: SiteAdminManagementClientOptions; scope: string; client: unknown }
const siteAdminManagementClients = new WeakMap<ReturnType<typeof useNuxtApp>, ScopedManagementClient[]>()
export interface SiteAdminModelOptions extends SiteAdminLocaleOptions {
  page?: Ref<number>
  pageSize?: number
  all?: boolean
  q?: MaybeRefOrGetter<string | undefined>
  authScope?: MaybeRefOrGetter<string>
  immediate?: boolean
  server?: boolean
  lazy?: boolean
}
type SiteAdminModelResource<Name extends string, Result> = Omit<AsyncData<Result, SiteAdminModelError | undefined>, 'then' | 'catch' | 'finally'> & Omit<SiteAdminModelActions<FormData<Name>>, 'data' | 'status' | 'error' | 'refresh'> & { page: Ref<number> }
type AwaitableModel<Name extends ManagementModelName, Result> = Promise<SiteAdminModelResource<Name, Result>> & SiteAdminModelResource<Name, Result>

export const useSiteAdminAuthScope = (provided?: MaybeRefOrGetter<string>, connection: SiteAdminManagementClientOptions = siteAdminManagementClientOptions()) => {
  const nuxtApp = useNuxtApp()
  ${options.auth ? 'const { user, session } = useUserSession()' : ''}
  const scope = computed(() => toValue(provided) ?? ${options.auth ? 'JSON.stringify([user.value?.id ?? null, (user.value as { role?: string } | null)?.role ?? null, session.value?.id ?? null])' : "'anonymous'"})
  watch(scope, (_next, previous) => nuxtApp.runWithContext(() => {
    const clients = siteAdminManagementClients.get(nuxtApp)
    if (clients) siteAdminManagementClients.set(nuxtApp, clients.filter((item) => !(item.scope === previous && item.connection.origin === connection.origin && item.connection.basePath === connection.basePath)))
    const drafts = useState<Record<string, SiteAdminSessionDraft>>('site-admin:form-drafts', () => Object.create(null)).value
    for (const key of Object.keys(drafts)) {
      try { const [origin, base, auth] = JSON.parse(key.slice('site-admin-management:'.length)); if (origin === connection.origin && base === connection.basePath && auth === previous) delete drafts[key] } catch {}
    }
    clearNuxtData((key) => {
    if (!key.startsWith('site-admin-management:')) return false
    try { const [origin, base, auth] = JSON.parse(key.slice('site-admin-management:'.length)); return origin === connection.origin && base === connection.basePath && auth === previous } catch { return false }
    })
  }), { flush: 'sync' })
  return scope
}

export const siteAdminManagementKey = (connection: SiteAdminManagementClientOptions, scope: string, operation: string, model: string | null, identity: unknown, locale?: string): string =>
  'site-admin-management:' + JSON.stringify([connection.origin ?? 'same-origin', connection.basePath ?? ${JSON.stringify(options.managementBase)}, scope, operation, model, identity, locale ?? null])

const siteAdminCachedEntryId = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const id = (data as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

const siteAdminInvalidateMutation = async (connection: SiteAdminManagementClientOptions, scope: string, mutation: SiteAdminMutation): Promise<void> => {
  const keys: string[] = []
  // useNuxtData subscribes to AsyncData; mutation observers must only inspect serialized DTOs.
  const payload = useNuxtApp().payload.data
  clearNuxtData((key) => {
    let matches = false
    try {
      if (key.startsWith('site-admin-management:')) {
        const [origin, base, auth, operation, model, id] = JSON.parse(key.slice('site-admin-management:'.length))
        matches = origin === connection.origin && base === connection.basePath && auth === scope &&
          ((operation === 'list' && model === mutation.model) || ((operation === 'entry' || operation === 'form-entry') && (!mutation.model || model === mutation.model) && id === mutation.id))
      } else if (key.startsWith('site-admin:')) {
        const [origin, base, operation, model, selector] = JSON.parse(key.slice('site-admin:'.length))
        if (origin === connection.origin && base === ${JSON.stringify(options.basePath)}) {
          if (operation === 'list') matches = model === mutation.model
          // Native transform/pick may remove identity; conservatively clear that model's unidentifiable entries.
          else if (operation === 'entry') {
            const cachedId = siteAdminCachedEntryId(payload[key])
            matches = model === mutation.model && (selector === mutation.id || cachedId === mutation.id || cachedId === undefined)
          }
          else if (operation === 'batch') {
            const cached = payload[key] as Record<string, { data: { id?: string } | unknown[] | null }> | undefined
            matches = (selector as Array<[string, string, string, string | null]>).some(([name, operation, model, id]) =>
              model === mutation.model && (operation === 'list' || id === mutation.id || siteAdminCachedEntryId(cached?.[name]?.data) === mutation.id || siteAdminCachedEntryId(cached?.[name]?.data) === undefined))
          }
        }
      }
    } catch { return false }
    if (matches) keys.push(key)
    return matches
  })
  if (keys.length) await refreshNuxtData(keys)
}

export const createNuxtSiteAdminManagementClient = <Models extends { [Name in keyof Models]: Record<string, unknown> } = SiteAdminManagementModels>(connection: SiteAdminManagementClientOptions, auth: MaybeRefOrGetter<string>) => {
  const nuxtApp = useNuxtApp()
  const scoped = (): SiteAdminManagementClient<Models> => {
    const scope = toValue(auth)
    const clients = siteAdminManagementClients.get(nuxtApp) ?? []
    const cached = clients.find((item) => item.scope === scope && item.connection.origin === connection.origin && item.connection.basePath === connection.basePath && item.connection.fetch === connection.fetch && item.connection.credentials === connection.credentials)
    if (cached) return cached.client as SiteAdminManagementClient<Models>
    const snapshot = { ...connection }
    const client = createSiteAdminManagementClient<Models>({ ...snapshot, onMutation: (mutation) => nuxtApp.runWithContext(() => siteAdminInvalidateMutation(snapshot, scope, mutation)) })
    clients.push({ connection: snapshot, scope, client })
    siteAdminManagementClients.set(nuxtApp, clients)
    return client
  }
  // Capture auth per invocation, including concurrent mutations and a user change while saving.
  return new Proxy(scoped(), { get(_target, property) {
    const value: unknown = Reflect.get(scoped(), property)
    if (typeof value !== 'function') return value
    return (...args: unknown[]) => {
      const scope = toValue(auth)
      const result = (Reflect.get(scoped(), property) as (...args: unknown[]) => unknown)(...args)
      if (!(result instanceof Promise)) return result
      return result.then(value => {
        if (scope !== toValue(auth)) throw new DOMException('Authentication changed during the request.', 'AbortError')
        return value
      })
    }
  } })
}

export const useSiteAdminModels = (connection: SiteAdminManagementClientOptions, auth: MaybeRefOrGetter<string>, immediate = true) => {
  const client = createNuxtSiteAdminManagementClient(connection, auth)
  const key = computed(() => siteAdminManagementKey(connection, toValue(auth), 'models', null, null))
  return siteAdminAttachAsyncData(() => key.value, (_app, { signal }) => client.models({ signal }), { dedupe: 'defer', immediate })
}

export const siteAdminReadModels = async (source: ReturnType<typeof useSiteAdminModels>, auth: MaybeRefOrGetter<string>, signal: AbortSignal): Promise<SiteAdminDescriptor> => {
  const scope = toValue(auth)
  await nextTick()
  signal.throwIfAborted()
  if (scope !== toValue(auth)) throw new DOMException('Authentication changed while loading models.', 'AbortError')
  // A form/ID cancellation must not abort a descriptor request shared by other consumers.
  if (!source.data.value) await source.execute({ dedupe: 'defer' })
  signal.throwIfAborted()
  if (scope !== toValue(auth)) throw new DOMException('Authentication changed while loading models.', 'AbortError')
  if (source.error.value) throw source.error.value
  if (!source.data.value) throw new SiteAdminClientError('SITE_ADMIN_INVALID_RESPONSE', 'Model descriptor is unavailable.', 502)
  return source.data.value
}

const siteAdminModelDescriptor = (source: SiteAdminDescriptor, model: string): ModelDescriptor => {
  const descriptor = Object.hasOwn(source.models, model) ? source.models[model] : undefined
  if (!descriptor) throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', '[site-admin] Form model "' + model + '" is unavailable to this actor.', 403)
  return descriptor
}

type ModelActions<Name extends string> = SiteAdminModelActions<FormData<Name>>
type SingleResource<Name extends string> = Omit<SiteAdminModelResource<Name, SiteAdminEntry<FormData<Name>> | null>, 'publish' | 'schedule'> & {
  publish: (value?: FormData<Name>) => ReturnType<ModelActions<Name>['publish']>
  schedule: (at: string, value?: FormData<Name>) => ReturnType<ModelActions<Name>['schedule']>
}
type ListResource<Name extends string> = Omit<SiteAdminModelResource<Name, SiteAdminEntryPage<FormData<Name>>>, 'save' | 'schedule' | 'restore'> & {
  schedule: (entry: SiteAdminEntry<FormData<Name>>, at: string) => ReturnType<ModelActions<Name>['schedule']>
  restore: (entry: SiteAdminEntry<FormData<Name>>, revision: string) => ReturnType<ModelActions<Name>['restore']>
}
type ValidModel<Name extends string> = Name & (Name extends ManagementModelName ? unknown : string extends Name ? unknown : never)
export const useAdminEntries = <Name extends string>(model: ValidModel<Name>, options: SiteAdminModelOptions = {}) => useAdminResource(model, options) as unknown as Promise<ListResource<Name>> & ListResource<Name>
export const useAdminEntry = <Name extends string>(model: ValidModel<Name>, id: MaybeRefOrGetter<string | null>, options: SiteAdminModelOptions = {}) => useAdminResource(model, { ...options, id }) as unknown as Promise<SingleResource<Name>> & SingleResource<Name>
function useAdminResource(model: string, options: SiteAdminModelOptions & { id?: MaybeRefOrGetter<string | null> }) {
  const connection = siteAdminManagementClientOptions()
  const auth = useSiteAdminAuthScope(options.authScope, connection)
  const locale = computed(() => toValue(options.locale))
  const client = createNuxtSiteAdminManagementClient<Record<string, Record<string, unknown>>>(connection, auth)
  const modelsSource = useSiteAdminModels(connection, auth, false)
  const descriptor = computed(() => modelsSource.data.value && Object.hasOwn(modelsSource.data.value.models, model) ? modelsSource.data.value.models[model] : undefined)
  const single = options.id !== undefined
  const id = ref(single ? toValue(options.id!) : null)
  watch(() => toValue(options.id), (value) => { id.value = value ?? null }, { flush: 'sync' })
  const page = options.page ?? ref(1)
  const size = options.pageSize ?? 20
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new TypeError('[site-admin] pageSize must be an integer from 1 to 100.')
  watch([locale, () => toValue(options.q)], () => { page.value = 1 }, { flush: 'sync' })
  const query = computed(() => ({ ...(locale.value === undefined ? {} : { locale: locale.value }), ...(toValue(options.q) === undefined ? {} : { q: toValue(options.q)! }), limit: size, offset: (Math.max(1, page.value) - 1) * size }))
  const identity = computed(() => siteAdminManagementKey(connection, auth.value, 'form', model, toValue(options.id) ?? null, locale.value))
  const key = computed(() => siteAdminManagementKey(connection, auth.value, single ? 'entry' : 'list', model, single ? id.value : options.all ? { locale: locale.value, q: toValue(options.q), all: true } : query.value, locale.value))
  let retained: unknown
  let retainedKey: string | undefined
  const source = siteAdminAttachAsyncData(() => key.value, async (_app, { signal }) => {
    const requestedKey = key.value
    try {
    const models = await siteAdminReadModels(modelsSource, auth, signal)
    const descriptor = siteAdminModelDescriptor(models, model)
    const present = (entry: SiteAdminEntry) => {
      if (entry.model !== model || (locale.value !== undefined && entry.locale !== locale.value)) throw new SiteAdminClientError('SITE_ADMIN_INVALID_RESPONSE', 'Entry does not belong to the requested model and locale.', 502)
      return { ...entry, data: presentSiteAdminData(descriptor, entry.data, client.assetUrl) }
    }
    const result = single
      ? id.value === null ? null : present(await client.getEntry(id.value, { signal }))
      : options.all
        ? await client.listAllEntries(model, { ...query.value, limit: 100, signal }).then((items) => ({ items: items.map(present), total: items.length, limit: items.length, offset: 0 }))
        : await client.listEntries(model, { ...query.value, signal }).then((result) => ({ ...result, items: result.items.map(present) }))
    signal.throwIfAborted()
    if (requestedKey === key.value) { retained = result; retainedKey = requestedKey }
    return result
    } catch (error) { throw siteAdminModelError(error) }
  }, { immediate: options.immediate, server: options.server, lazy: options.lazy, dedupe: 'defer', default: () => retainedKey === key.value ? retained : undefined })
  const nativeRefresh = source.refresh
  const refresh = async (...args: Parameters<typeof nativeRefresh>) => {
    await nativeRefresh(...args)
    const result = source.data.value
    if (!single && !options.all && result) {
      const last = Math.max(1, Math.ceil(result.total / size))
      if (page.value > last) { page.value = last; await nextTick(); await nativeRefresh(...args) }
    }
  }
  const nuxtApp = useNuxtApp()
  const core = createSiteAdminModel({ ...source, refresh }, {
    model, descriptor, id, identity, locale, client,
    prepare: (context) => nuxtApp.runWithContext(() => nuxtApp.callHook('site-admin:entry:prepare', context)),
    drafts: useState<Record<string, SiteAdminSessionDraft>>('site-admin:form-drafts', () => Object.create(null)).value,
  })
  const actions = { ...core, page, refresh, ...(single ? {
    publish: (value?: Record<string, unknown>) => core.publish(undefined, value),
    schedule: (at: string, value?: Record<string, unknown>) => core.schedule(at, undefined, value),
  } : {
    schedule: (entry: SiteAdminEntry, at: string) => core.schedule(at, entry),
    restore: (entry: SiteAdminEntry, revision: string) => core.restore(revision, entry),
  }) }
  // Both the immediate object and Nuxt's awaited object expose the same extension.
  return Object.assign(source.then((value) => Object.assign(value, actions)), source, actions)
}
`
