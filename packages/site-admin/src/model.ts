import { prepareAdminEntry } from './entry-preparation'
import { resolveTranslation, type TranslationInput } from './i18n'
import { createError, type H3Error } from 'h3'
import {
    computed,
    getCurrentScope,
    onScopeDispose,
    toValue,
    watch,
    reactive,
    readonly,
    type MaybeRefOrGetter,
    type Ref,
} from 'vue'
import type { ModelMeta } from './presentation'
import { SiteAdminClientError } from './client'
import type { SiteAdminEntry, SiteAdminEntryMutation, SiteAdminEntryPage, SiteAdminManagementClient } from './client'
import type { ModelDescriptor } from './descriptor'
import { SiteAdminError } from './errors'
import { presentSiteAdminData, serializeSiteAdminData } from './management-assets'

export interface SiteAdminFailure {
    code: string
    issues?: Array<{ path: string; message: string }>
    committed?: boolean
    receipt?: { id: string; model: string; version: number; deleted?: boolean }
    effects?: { assets: 'pending' }
}
export type SiteAdminModelError = H3Error<SiteAdminFailure>
export const siteAdminModelError = (cause: unknown, committed = false): SiteAdminModelError => {
    const payload = cause as {
        data?: { error?: { code?: string; message?: string; issues?: SiteAdminFailure['issues'] } }
        statusCode?: number
    }
    if (payload?.data?.error?.code && payload.data.error.message) {
        return createError<SiteAdminFailure>({
            message: payload.data.error.message,
            statusCode: payload.statusCode ?? 500,
            data: {
                code: payload.data.error.code,
                ...(payload.data.error.issues ? { issues: payload.data.error.issues } : {}),
            },
            cause,
        })
    }
    const structured = cause instanceof SiteAdminClientError || cause instanceof SiteAdminError
    const failure = structured
        ? {
              code: cause.code,
              ...(cause.issues ? { issues: cause.issues } : {}),
              ...(cause.committed ? { committed: true, receipt: cause.receipt, effects: cause.effects } : {}),
          }
        : ((cause as SiteAdminModelError)?.data ?? { code: 'SITE_ADMIN_REQUEST_FAILED' })
    return createError<SiteAdminFailure>({
        message: cause instanceof Error ? cause.message : 'Site Admin request failed.',
        statusCode: structured ? cause.status : ((cause as SiteAdminModelError)?.statusCode ?? 500),
        data: {
            ...failure,
            code: typeof failure.code === 'string' ? failure.code : 'SITE_ADMIN_REQUEST_FAILED',
            ...(committed ? { committed: true } : {}),
        },
        cause,
    })
}
export type SiteAdminModelData<Data> = SiteAdminEntry<Data> | SiteAdminEntryPage<Data> | null | undefined
export const siteAdminSnapshot = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
            : item,
    )
export interface SiteAdminModelState<Data extends Record<string, unknown>> {
    data: Ref<SiteAdminModelData<Data>>
    status: Ref<'idle' | 'pending' | 'success' | 'error'>
    error: Ref<SiteAdminModelError | undefined>
    refresh: () => Promise<unknown>
}
export interface SiteAdminSessionDraft {
    locale?: string
    value: Record<string, unknown>
    baseline: Record<string, unknown>
    entryId: string | null
    version: number | null
    pendingPublication?: boolean
}
export interface EntryFeatures {
    publishing: boolean
    scheduling: boolean
    revisions: boolean
    sortable: boolean
}
export interface EntryPrepareContext<Data extends Record<string, unknown> = Record<string, unknown>> {
    locale: string
    defaultLocale: string
    model: string
    resource: { display(value: Data): ReturnType<SiteAdminModel<Data>['display']> }
    entry: SiteAdminEntry<Data> | undefined
    features: EntryFeatures
    operation: 'save' | 'publish' | 'schedule'
    value: Data
    signal: AbortSignal
}
export const siteAdminModelContext = Symbol('site-admin-model')
export interface SiteAdminModelContext<Data extends Record<string, unknown>> {
    model: string
    descriptor: Ref<ModelDescriptor | undefined>
    id: Ref<string | null>
    identity: MaybeRefOrGetter<string>
    defaultLocale?: string
    locale: MaybeRefOrGetter<string | undefined>
    client: SiteAdminManagementClient<Record<string, Record<string, unknown>>>
    drafts: Record<string, SiteAdminSessionDraft>
    prepare?: (context: EntryPrepareContext<Data>) => void | Promise<void>
    receipt?: SiteAdminEntryMutation<Data>
    report: (error: unknown, committed?: boolean) => SiteAdminModelError
    run: <Result>(
        key: string,
        operation: (signal: AbortSignal) => Promise<Result>,
        mutation?: boolean,
    ) => Promise<Result>
    submit: (
        operation: 'save' | 'publish' | 'schedule',
        value: Data,
        at?: string,
        guard?: () => void,
        snapshot?: { data: Partial<Data>; translations: TranslationInput<Data> },
    ) => Promise<SiteAdminEntryMutation<Data>>
}

/** One coordinator owns the queue, receipts and preparation for lists and forms. */
export const createSiteAdminModel = <Data extends Record<string, unknown>>(
    state: SiteAdminModelState<Data>,
    input: Omit<SiteAdminModelContext<Data>, 'run' | 'report' | 'submit'>,
) => {
    let tail: Promise<unknown> = Promise.resolve()
    const pending = new Map<string, Promise<unknown>>()
    const controllers = new Set<AbortController>()
    const abort = () => {
        for (const controller of controllers) controller.abort()
        controllers.clear()
    }
    if (getCurrentScope()) onScopeDispose(abort)
    const report = (cause: unknown, committed = false) => {
        const error = siteAdminModelError(cause, committed)
        state.error.value = error
        state.status.value = 'error'
        return error
    }
    const run: SiteAdminModelContext<Data>['run'] = (key, operation, mutation = true) => {
        const identity = toValue(input.identity)
        const token = identity + ':' + key
        const existing = pending.get(token)
        if (existing) return existing as ReturnType<typeof operation>
        const controller = new AbortController()
        controllers.add(controller)
        const request = tail
            .catch(() => {})
            .then(async () => {
                let committed = false
                try {
                    controller.signal.throwIfAborted()
                    if (identity !== toValue(input.identity))
                        throw new DOMException('Resource identity changed.', 'AbortError')
                    state.status.value = 'pending'
                    state.error.value = undefined
                    const result = await operation(controller.signal)
                    committed = mutation
                    if (identity === toValue(input.identity)) {
                        if (mutation) {
                            await state.refresh()
                            if (state.error.value) throw state.error.value
                        }
                        if (!state.error.value) state.status.value = 'success'
                    }
                    return result
                } catch (cause) {
                    if (identity !== toValue(input.identity)) throw cause
                    const receipt = (cause as { receipt?: SiteAdminFailure['receipt'] }).receipt
                    if (receipt) {
                        if (receipt.deleted) {
                            delete context.receipt
                            const data = state.data.value
                            if (data && 'items' in data)
                                state.data.value = {
                                    ...data,
                                    items: data.items.filter((entry) => entry.id !== receipt.id),
                                    total: Math.max(0, data.total - 1),
                                }
                            else if (data && data.id === receipt.id) state.data.value = null
                        } else {
                            context.receipt = receipt as import('./client').SiteAdminEntryMutation<Data>
                            input.id.value = receipt.id
                        }
                    }
                    if ((cause as { committed?: boolean }).committed) {
                        await state.refresh().catch(() => {})
                    }
                    throw report(cause, committed)
                } finally {
                    pending.delete(token)
                    controllers.delete(controller)
                }
            })
        pending.set(token, request)
        tail = request
        return request
    }
    const context = { ...input, run, report } as SiteAdminModelContext<Data>
    watch(
        () => toValue(input.identity),
        () => {
            abort()
            delete context.receipt
        },
        { flush: 'sync' },
    )
    const getDescriptor = () => {
        if (!input.descriptor.value)
            throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', 'Model is unavailable.', 403)
        return input.descriptor.value
    }
    const features = computed<EntryFeatures>(() => ({
        publishing: input.descriptor.value?.publishing ?? false,
        scheduling: input.descriptor.value?.scheduling ?? false,
        revisions: input.descriptor.value?.revisions ?? false,
        sortable: input.descriptor.value?.sortable ?? false,
    }))
    const head = () => {
        const loaded = state.data.value && 'id' in state.data.value ? state.data.value : undefined
        return loaded && context.receipt?.id === loaded.id && context.receipt.version > loaded.version
            ? context.receipt
            : (loaded ?? context.receipt)
    }
    const current = (selected?: SiteAdminEntry<Data>): SiteAdminEntry<Data> => {
        const data = state.data.value
        const loaded =
            selected && data && 'items' in data ? data.items.find((entry) => entry.id === selected.id) : undefined
        const value = loaded ?? selected ?? head()
        const receipt =
            value && context.receipt?.id === value.id && context.receipt.version > value.version
                ? context.receipt
                : value
        if (!receipt || receipt.model !== input.model)
            throw new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Select an entry from this model.', 400)
        return receipt as SiteAdminEntry<Data>
    }
    const accept = (
        result: SiteAdminEntryMutation<Record<string, unknown>>,
        expected?: { id: string; version: number },
    ): SiteAdminEntryMutation<Data> => {
        if (
            !result ||
            !result.id ||
            result.model !== input.model ||
            !Number.isSafeInteger(result.version) ||
            result.version < 1 ||
            (expected && (result.id !== expected.id || result.version <= expected.version))
        )
            throw siteAdminModelError(
                new SiteAdminClientError(
                    'SITE_ADMIN_INVALID_RESPONSE',
                    'The mutation returned an invalid entry or version. Reload before saving again.',
                    502,
                ),
                true,
            )
        const entry =
            'data' in result
                ? { ...result, data: presentSiteAdminData<Data>(getDescriptor(), result.data, input.client.assetUrl) }
                : result
        context.receipt = entry
        const previous = state.data.value
        if (previous && 'items' in previous)
            state.data.value = {
                ...previous,
                items: previous.items.map((item) => (item.id === result.id ? { ...item, ...entry } : item)),
            }
        else if ('data' in entry) state.data.value = entry
        else if (previous && 'id' in previous && previous.id === entry.id) state.data.value = { ...previous, ...entry }
        return entry
    }
    const prepare = async (
        operation: EntryPrepareContext['operation'],
        value: Data,
        entry: SiteAdminEntry<Data> | undefined,
        signal: AbortSignal,
        guard?: () => void,
        snapshot?: { data: Partial<Data>; translations: TranslationInput<Data> },
    ) => {
        const descriptor = input.descriptor.value!
        const locale = entry
            ? (toValue(input.locale) ?? entry.defaultLocale)
            : (input.defaultLocale ?? toValue(input.locale) ?? '')
        const serialized = serializeSiteAdminData(descriptor, value)
        if (entry && 'data' in entry) {
            const previous = resolveTranslation(entry, locale).data
            for (const key of Object.keys(descriptor.fields))
                if (serialized[key] === undefined && previous[key] !== undefined) serialized[key] = null
        }
        const translated = entry && 'data' in entry && locale !== entry.defaultLocale
        let data = serialized as Partial<Data>
        let translations: TranslationInput<Data> | undefined
        if (snapshot) {
            data = snapshot.data
            translations = snapshot.translations
        } else if (translated) {
            const baseline = serializeSiteAdminData(descriptor, resolveTranslation(entry, locale).data)
            data = Object.fromEntries(
                Object.entries(serialized).filter(
                    ([key]) =>
                        !descriptor.fields[key]?.i18n &&
                        siteAdminSnapshot(serialized[key]) !== siteAdminSnapshot(baseline[key]),
                ),
            ) as Partial<Data>
            const previous = entry.translations[locale] ?? {}
            const override = { ...previous }
            for (const [key, field] of Object.entries(descriptor.fields))
                if (field.i18n && siteAdminSnapshot(serialized[key]) !== siteAdminSnapshot(baseline[key]))
                    override[key] = serialized[key]
            if (Object.keys(override).length || Object.hasOwn(entry.translations, locale))
                translations = { [locale]: override } as TranslationInput<Data>
        }
        return prepareAdminEntry({
            model: input.model,
            descriptor,
            ...(entry && 'data' in entry ? { entry } : {}),
            operation,
            input: { data, ...(translations ? { translations } : {}) },
            defaultLocale: entry?.defaultLocale ?? locale,
            assetUrl: input.client.assetUrl,
            signal,
            ...(input.prepare ? { prepare: input.prepare } : {}),
            resource: actions,
            ...(guard ? { guard } : {}),
        })
    }

    const write = async (
        entry: SiteAdminEntry<Data> | undefined,
        candidate: Awaited<ReturnType<typeof prepare>>,
        signal: AbortSignal,
    ) => {
        const result = entry
            ? await input.client.updateEntry(entry.id, { ...candidate, expectedVersion: entry.version }, { signal })
            : await input.client.createEntry(
                  input.model,
                  { ...candidate, ...(input.defaultLocale ? { defaultLocale: input.defaultLocale } : {}) },
                  { signal },
              )
        signal.throwIfAborted()
        const accepted = accept(result, entry)
        input.id.value = result.id
        return accepted
    }
    const submit = (
        operation: EntryPrepareContext['operation'],
        value?: Data,
        selected?: SiteAdminEntry<Data>,
        at?: string,
        guard?: () => void,
        snapshot?: { data: Partial<Data>; translations: TranslationInput<Data> },
    ) =>
        run(siteAdminSnapshot([operation, selected?.id ?? input.id.value, value, at, snapshot]), async (signal) => {
            let entry = selected ? current(selected) : (head() as SiteAdminEntry<Data> | undefined)
            if (!entry && input.id.value !== null)
                throw new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Load the entry before saving.', 400)
            const data = value ?? entry?.data
            if (!data) throw new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Entry data is required.', 400)
            if (operation !== 'save' && !features.value[operation === 'publish' ? 'publishing' : 'scheduling'])
                throw new SiteAdminClientError(
                    'SITE_ADMIN_INVALID_INPUT',
                    'This operation is disabled for this model.',
                    400,
                )
            // Keep the first draft if application preparation or publication fails.
            if (!entry && operation !== 'save') {
                const saved = await write(
                    undefined,
                    await prepare('save', data, undefined, signal, guard, snapshot),
                    signal,
                )
                entry = (
                    'data' in saved
                        ? saved
                        : {
                              ...saved,
                              data,
                              defaultLocale: input.defaultLocale ?? toValue(input.locale) ?? '',
                              translations: {},
                          }
                ) as SiteAdminEntry<Data>
            }
            const candidate = await prepare(operation, data, entry, signal, guard, snapshot)
            if (operation === 'save') return write(entry, candidate, signal)
            const result =
                operation === 'publish'
                    ? await input.client.publishEntry(
                          entry!.id,
                          { expectedVersion: entry!.version, draft: candidate },
                          { signal },
                      )
                    : await input.client.schedulePublish(
                          entry!.id,
                          { at: at!, expectedVersion: entry!.version, draft: candidate },
                          { signal },
                      )
            signal.throwIfAborted()
            return accept(result, entry)
        })
    context.submit = (operation, value, at, guard, snapshot) => submit(operation, value, undefined, at, guard, snapshot)
    const mutate = (
        name: string,
        selected: SiteAdminEntry<Data> | undefined,
        operation: (
            entry: SiteAdminEntry<Data>,
            signal: AbortSignal,
        ) => Promise<SiteAdminEntryMutation<Record<string, unknown>> | void>,
        extra?: unknown,
    ) =>
        run(siteAdminSnapshot([name, selected?.id ?? input.id.value, extra]), async (signal) => {
            const entry = current(selected)
            const result = await operation(entry, signal)
            signal.throwIfAborted()
            return result ? accept(result, entry) : undefined
        })
    const meta = reactive<ModelMeta>({ label: input.model, plural: input.model })
    watch(
        () => input.descriptor.value?.meta,
        (value) => {
            for (const key of Object.keys(meta)) if (key !== 'label' && key !== 'plural') delete meta[key]
            Object.assign(meta, { label: input.model, plural: input.model }, value)
        },
        { immediate: true, flush: 'sync' },
    )
    const actions = {
        meta: readonly(meta),
        data: state.data,
        status: state.status,
        error: state.error,
        refresh: state.refresh,
        [siteAdminModelContext]: context,
        features,
        save: (value: Data) => submit('save', value),
        publish: (selected?: SiteAdminEntry<Data>, value?: Data) => submit('publish', value, selected),
        schedule: (valueAt: Date | string, selected?: SiteAdminEntry<Data>, value?: Data) => {
            const at = new Date(valueAt)
            if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
                return Promise.reject(
                    report(
                        new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Choose a future publication time.', 400),
                    ),
                )
            return submit('schedule', value, selected, at.toISOString())
        },
        unpublish: (entry?: SiteAdminEntry<Data>) =>
            mutate('unpublish', entry, (item, signal) =>
                input.client.unpublishEntry(item.id, { expectedVersion: item.version }, { signal }),
            ),
        cancelSchedule: (entry?: SiteAdminEntry<Data>) =>
            mutate('cancel-schedule', entry, (item, signal) =>
                input.client.cancelScheduledPublish(item.id, { expectedVersion: item.version }, { signal }),
            ),
        remove: (entry?: SiteAdminEntry<Data>) =>
            mutate('remove', entry, (item, signal) =>
                input.client.deleteEntry(item.id, { expectedVersion: item.version }, { signal }),
            ),
        restore: (revision: string, entry?: SiteAdminEntry<Data>) =>
            mutate(
                'restore',
                entry,
                (item, signal) =>
                    input.client.restoreRevision(item.id, revision, { expectedVersion: item.version }, { signal }),
                revision,
            ),
        revisions: (entry?: SiteAdminEntry<Data>) =>
            run(
                'revisions:' + (entry?.id ?? input.id.value),
                async () =>
                    (await input.client.listRevisions<Data>(current(entry).id)).map((revision) => ({
                        ...revision,
                        data: presentSiteAdminData<Data>(getDescriptor(), revision.data, input.client.assetUrl),
                    })),
                false,
            ),
        reorder: (entries: SiteAdminEntry<Data>[]) =>
            run(siteAdminSnapshot(['reorder', entries.map(({ id }) => id)]), async () => {
                if (!features.value.sortable)
                    throw new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'This model cannot be reordered.', 400)
                const previous = state.data.value
                if (previous && 'items' in previous) state.data.value = { ...previous, items: entries }
                try {
                    return await input.client.setSortOrders(
                        input.model,
                        entries.map(({ id, version }, sortOrder) => ({ id, expectedVersion: version, sortOrder })),
                    )
                } catch (error) {
                    state.data.value = previous
                    throw error
                }
            }),
        display: (value: Data) => {
            const fields = getDescriptor().displayFields
            const raw = value[fields?.image ?? 'images']
            const image = Array.isArray(raw) ? raw[0] : raw
            return {
                title: String(value[fields?.title ?? 'title'] ?? ''),
                description: String(value[fields?.description ?? 'description'] ?? ''),
                image:
                    image && typeof image === 'object' && 'url' in image && typeof image.url === 'string'
                        ? image.url
                        : undefined,
            }
        },
    }
    return actions
}
export type SiteAdminModelActions<Data extends Record<string, unknown>> = ReturnType<typeof createSiteAdminModel<Data>>
export type SiteAdminModel<Data extends Record<string, unknown>> = SiteAdminModelState<Data> &
    SiteAdminModelActions<Data>
