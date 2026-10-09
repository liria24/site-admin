import type { SiteAdminClientTemplateOptions } from './client-templates'

const overloads = (kind: 'Entry' | 'List'): string => {
    const response = kind === 'Entry' ? 'SiteAdminEntry<FormData<Name>>' : 'SiteAdminEntryPage<FormData<Name>>'
    const id = kind === 'Entry' ? ', id: MaybeRefOrGetter<string>' : ''
    return ['WithTransform', '']
        .flatMap((transform) =>
            ['undefined', 'DataT'].map(
                (fallback) =>
                    `export function useSiteAdminManagement${kind}<Name extends ManagementModelName, ErrorData = unknown, DataT = ${response}, PickKeys extends KeysOf<DataT> = KeysOf<DataT>, DefaultT = ${fallback}>(model: Name${id}, options${transform ? '' : '?'}: AsyncDataOptions${transform}<${response}, DataT, PickKeys, DefaultT> & SiteAdminManagementDataOptions): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, SiteAdminAsyncDataError<ErrorData> | undefined>`,
            ),
        )
        .join('\n')
}

/** All cache enumeration/invalidation goes through Nuxt's public data APIs. */
export const siteAdminNuxtManagementDataTemplate = (options: SiteAdminClientTemplateOptions): string => `
import type { SiteAdminEntry, SiteAdminEntryPage, SiteAdminFormModels, SiteAdminManagementModels, SiteAdminMutation } from '@liria24/site-admin/client'
import { presentSiteAdminData } from '@liria24/site-admin/client'
import type { ModelDescriptor, SiteAdminDescriptor } from '@liria24/site-admin'
import { clearNuxtData, refreshNuxtData, useNuxtApp${options.auth ? ', useUserSession' : ''} } from '#imports'
import { watch } from 'vue'

type ManagementModelName = Extract<keyof SiteAdminFormModels, string>
type FormData<Name extends ManagementModelName> = Extract<SiteAdminFormModels[Name], Record<string, unknown>>
type ScopedManagementClient = { connection: SiteAdminManagementClientOptions; scope: string; client: unknown }
const siteAdminManagementClients = new WeakMap<ReturnType<typeof useNuxtApp>, ScopedManagementClient[]>()
export interface SiteAdminManagementDataOptions extends SiteAdminLocaleOptions {
  limit?: MaybeRefOrGetter<number | undefined>
  offset?: MaybeRefOrGetter<number | undefined>
  q?: MaybeRefOrGetter<string | undefined>
  authScope?: MaybeRefOrGetter<string>
}

export const useSiteAdminAuthScope = (provided?: MaybeRefOrGetter<string>, connection: SiteAdminManagementClientOptions = siteAdminManagementClientOptions()) => {
  const nuxtApp = useNuxtApp()
  ${options.auth ? 'const { user, session } = useUserSession()' : ''}
  const scope = computed(() => toValue(provided) ?? ${options.auth ? 'JSON.stringify([user.value?.id ?? null, (user.value as { role?: string } | null)?.role ?? null, session.value?.id ?? null])' : "'anonymous'"})
  watch(scope, (_next, previous) => nuxtApp.runWithContext(() => {
    const clients = siteAdminManagementClients.get(nuxtApp)
    if (clients) siteAdminManagementClients.set(nuxtApp, clients.filter((item) => !(item.scope === previous && item.connection.origin === connection.origin && item.connection.basePath === connection.basePath)))
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
        const [origin, base, operation, model, slug] = JSON.parse(key.slice('site-admin:'.length))
        if (origin === connection.origin && base === ${JSON.stringify(options.basePath)}) {
          if (operation === 'list') matches = model === mutation.model
          // Native transform/pick may remove identity; conservatively clear that model's unidentifiable entries.
          else if (operation === 'entry') {
            const cachedId = siteAdminCachedEntryId(payload[key])
            matches = model === mutation.model && (slug === mutation.id || (mutation.slug !== undefined && slug === mutation.slug) || cachedId === mutation.id || cachedId === undefined)
          }
          else if (operation === 'batch') {
            const cached = payload[key] as Record<string, { data: { id?: string } | unknown[] | null }> | undefined
            matches = (slug as Array<[string, string, string, string | null]>).some(([name, operation, model, id]) =>
              model === mutation.model && (operation === 'list' || id === mutation.id || (mutation.slug !== undefined && id === mutation.slug) || siteAdminCachedEntryId(cached?.[name]?.data) === mutation.id || siteAdminCachedEntryId(cached?.[name]?.data) === undefined))
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
      return (Reflect.get(scoped(), property) as (...args: unknown[]) => unknown)(...args)
    }
  } })
}

export const useSiteAdminModels = (connection: SiteAdminManagementClientOptions, auth: MaybeRefOrGetter<string>, immediate = true) => {
  const client = createNuxtSiteAdminManagementClient(connection, auth)
  const key = computed(() => siteAdminManagementKey(connection, toValue(auth), 'models', null, null))
  return siteAdminAsyncData(() => key.value, (_app, { signal }) => client.models({ signal }), { dedupe: 'defer', immediate })
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

${overloads('Entry')}
export function useSiteAdminManagementEntry(model: ManagementModelName, id: MaybeRefOrGetter<string>, options: AsyncDataOptions<SiteAdminEntry<FormData<ManagementModelName>>> & SiteAdminManagementDataOptions = {}) {
  const connection = siteAdminManagementClientOptions()
  const auth = useSiteAdminAuthScope(options.authScope, connection)
  const locale = computed(() => toValue(options.locale))
  const client = createNuxtSiteAdminManagementClient(connection, auth)
  const modelsSource = useSiteAdminModels(connection, auth, false)
  const key = computed(() => siteAdminManagementKey(connection, auth.value, 'entry', model, toValue(id), locale.value))
  const { authScope: _auth, locale: _locale, limit: _limit, offset: _offset, q: _q, ...asyncOptions } = options
  return siteAdminAsyncData(() => key.value, async (_app, { signal }) => {
    const requestedId = toValue(id)
    const requestedLocale = locale.value
    const [models, entry] = await Promise.all([siteAdminReadModels(modelsSource, auth, signal), client.getEntry(requestedId, { signal })])
    signal.throwIfAborted()
    if (entry.model !== model || (requestedLocale !== undefined && entry.locale !== requestedLocale)) throw new SiteAdminClientError('SITE_ADMIN_INVALID_RESPONSE', 'Entry does not belong to the requested model and locale.', 502)
    return { ...entry, data: presentSiteAdminData<FormData<ManagementModelName>>(siteAdminModelDescriptor(models, model), entry.data, client.assetUrl) }
  }, asyncOptions)
}

${overloads('List')}
export function useSiteAdminManagementList(model: ManagementModelName, options: AsyncDataOptions<SiteAdminEntryPage<FormData<ManagementModelName>>> & SiteAdminManagementDataOptions = {}) {
  const connection = siteAdminManagementClientOptions()
  const auth = useSiteAdminAuthScope(options.authScope, connection)
  const locale = computed(() => toValue(options.locale))
  const client = createNuxtSiteAdminManagementClient(connection, auth)
  const modelsSource = useSiteAdminModels(connection, auth, false)
  const query = computed(() => ({ ...(locale.value === undefined ? {} : { locale: locale.value }), ...(toValue(options.limit) === undefined ? {} : { limit: toValue(options.limit)! }), ...(toValue(options.offset) === undefined ? {} : { offset: toValue(options.offset)! }), ...(toValue(options.q) === undefined ? {} : { q: toValue(options.q)! }) }))
  const key = computed(() => siteAdminManagementKey(connection, auth.value, 'list', model, query.value, locale.value))
  const { authScope: _auth, locale: _locale, limit: _limit, offset: _offset, q: _q, ...asyncOptions } = options
  return siteAdminAsyncData(() => key.value, async (_app, { signal }) => {
    const [models, page] = await Promise.all([siteAdminReadModels(modelsSource, auth, signal), client.listEntries(model, { ...query.value, signal })])
    signal.throwIfAborted()
    const descriptor = siteAdminModelDescriptor(models, model)
    return { ...page, items: page.items.map((entry) => ({ ...entry, data: presentSiteAdminData<FormData<ManagementModelName>>(descriptor, entry.data, client.assetUrl) })) }
  }, asyncOptions)
}
`
