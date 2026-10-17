import { resolveTranslation } from './i18n'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { useForm, type DeepKeys } from '@tanstack/vue-form'
import {
    computed,
    getCurrentInstance,
    getCurrentScope,
    onMounted,
    onScopeDispose,
    readonly,
    shallowRef,
    toRaw,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue'
import { SiteAdminClientError, type SiteAdminEntry, type SiteAdminEntryMutation } from './client'
import { presentSiteAdminData, serializeSiteAdminData, siteAdminAsset } from './management-assets'
import { projectStoredFields } from './stored-data'
import type { FieldDescriptor, ModelDescriptor } from './descriptor'
import type { SiteAdminIssue } from './errors'
import { isRecord, validateBuiltinValue } from './validation-builtin'
import { siteAdminModelContext, siteAdminSnapshot, type SiteAdminModel } from './model'

export type { SiteAdminAsset } from './management-assets'
export type { SiteAdminSessionDraft } from './model'

export interface UseEntryFormOptions<Data extends Record<string, unknown>> {
    beforeUnload?: false | MaybeRefOrGetter<boolean>
    defaultValues?: Partial<Data>
    onBeforeSubmit?: (context: {
        operation: 'save' | 'publish' | 'schedule'
        locale?: string
        defaultLocale?: string
    }) => void | Promise<void>
    onUpload?: (context: {
        field: DeepKeys<Data>
        files: File[]
        assets: import('./management-assets').SiteAdminAsset[]
    }) => void | Promise<void>
    onSuccess?: (
        entry: SiteAdminEntryMutation<Data>,
        context: { operation: 'save' | 'publish' | 'schedule' },
    ) => void | Promise<void>
}

const fieldDefault = (field: FieldDescriptor): unknown => {
    if (field.default !== undefined) return structuredClone(toRaw(field.default))
    if (!field.required) return undefined
    if (field.kind === 'object') return defaultsFromFields(field.fields ?? {})
    if (field.kind === 'array' || field.kind === 'images') return []
    if (field.kind === 'boolean') return false
    if (field.kind === 'number') return 0
    return ''
}

const defaultsFromFields = (fields: Record<string, FieldDescriptor>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(fields).flatMap(([name, field]) => {
            const value = fieldDefault(field)
            return value === undefined ? [] : [[name, value]]
        }),
    )

export const siteAdminFormDefaults = <Data extends Record<string, unknown>>(
    model: ModelDescriptor,
    values: Partial<Data> = {},
): Data => ({ ...defaultsFromFields(model.fields), ...values }) as Data

const descriptorIssues = (
    fields: Record<string, FieldDescriptor>,
    data: Record<string, unknown>,
    parent = '',
): SiteAdminIssue[] => {
    const issues: SiteAdminIssue[] = Object.keys(data)
        .filter((name) => !Object.hasOwn(fields, name))
        .map((name) => ({ path: [parent, name].filter(Boolean).join('.'), message: 'Unknown field.' }))
    for (const [name, field] of Object.entries(fields)) {
        const path = [parent, name].filter(Boolean).join('.')
        const value = data[name]
        issues.push(...validateBuiltinValue(field, value, path))
        if (field.kind === 'object' && isRecord(value))
            issues.push(...descriptorIssues(field.fields ?? {}, value, path))
        else if (field.kind === 'array' && field.item && Array.isArray(value))
            for (const [index, item] of value.entries())
                issues.push(...descriptorIssues({ [index]: field.item }, { [index]: item }, path))
    }
    return issues
}

const descriptorSchema = <Data extends Record<string, unknown>>(
    model: ModelDescriptor,
): StandardSchemaV1<Data, Data> => ({
    '~standard': {
        validate: (value) => {
            const data = value as Data
            const issues = descriptorIssues(model.fields, data).map((issue) => ({
                message: issue.message,
                path: issue.path.split('.'),
            }))
            return issues.length > 0 ? { issues } : { value: data }
        },
        vendor: 'site-admin',
        version: 1,
    },
})

/** Native TanStack form, with only model-aware fields, uploads and draft operations added. */
export const useEntryForm = <Data extends Record<string, unknown>>(
    resource: Pick<SiteAdminModel<Data>, 'data' | 'status' | 'error' | 'refresh' | typeof siteAdminModelContext>,
    options: UseEntryFormOptions<Data> = {},
) => {
    if (resource.data.value && 'items' in resource.data.value)
        throw new TypeError(
            '[site-admin] Forms require an entry resource. Use useAdminEntry(model, null) for a new entry.',
        )
    const lifetime = new AbortController()
    if (getCurrentScope()) onScopeDispose(() => lifetime.abort())
    const context = resource[siteAdminModelContext]
    let cachedDescriptor = context.descriptor.value
    const descriptor = () => {
        cachedDescriptor = context.descriptor.value ?? cachedDescriptor
        return (
            cachedDescriptor ?? {
                fields: {},
                public: true,
                publishing: true,
                scheduling: true,
                revisions: true,
                route: false,
                serverValidation: false,
                sortable: false,
            }
        )
    }
    const present = (data: Record<string, unknown>) =>
        presentSiteAdminData<Data>(descriptor(), data, (id) => context.client.assetUrl(id))
    const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value
    const serialize = (value: Data) => serializeSiteAdminData(descriptor(), value)
    const currentEntry = () =>
        resource.data.value && 'id' in resource.data.value && resource.data.value.id === context.id.value
            ? resource.data.value
            : null
    const initial = currentEntry()
    const draftKey = () => toValue(context.identity)
    let storedKey = draftKey()
    let storedLocale = toValue(context.locale) ?? context.defaultLocale
    const stored = context.drafts[storedKey]
    let pendingPublication = stored?.pendingPublication ?? false
    const version = shallowRef(stored ? stored.version : (initial?.version ?? null))
    const entryId = shallowRef(initial?.id ?? stored?.entryId ?? null)
    // A new route can resume the draft created while running an app-owned AI action.
    if (entryId.value) context.id.value = entryId.value
    const defaultValue = (): Data => present(siteAdminFormDefaults(descriptor(), options.defaultValues))
    const draftGroup = (key: string) => {
        try {
            return JSON.stringify(JSON.parse(key.slice('site-admin-management:'.length)).slice(0, 6))
        } catch {
            return key
        }
    }
    const originalDraft = () =>
        Object.entries(context.drafts).find(
            ([key, draft]) => draftGroup(key) === draftGroup(draftKey()) && draft.locale === context.defaultLocale,
        )?.[1]
    const newDefaultValue = () => present(originalDraft()?.value ?? serialize(defaultValue()))
    const newSnapshot = (value: Data) => {
        if (currentEntry() || !context.defaultLocale) return undefined
        const locale = toValue(context.locale) ?? context.defaultLocale
        const data = {
            ...(locale === context.defaultLocale
                ? serialize(value)
                : (originalDraft()?.value ?? serialize(defaultValue()))),
        }
        const translations: import('./i18n').TranslationInput<Data> = {}
        const drafts = Object.entries(context.drafts).filter(([key]) => draftGroup(key) === draftGroup(draftKey()))
        for (const [, draft] of drafts) {
            if (!draft.locale || draft.locale === context.defaultLocale) continue
            const override = Object.fromEntries(
                Object.entries(descriptor().fields)
                    .filter(
                        ([key, field]) =>
                            field.i18n &&
                            siteAdminSnapshot(draft.value[key]) !== siteAdminSnapshot(draft.baseline[key]),
                    )
                    .map(([key]) => [key, draft.value[key]]),
            ) as Partial<Data>
            if (Object.keys(override).length) translations[draft.locale] = override
        }
        // Shared fields keep their single value even when edited in a translated view.
        for (const [key, field] of Object.entries(descriptor().fields))
            if (!field.i18n) data[key] = serialize(value)[key]
        return { data: data as Partial<Data>, translations }
    }

    const entryValue = (entry: SiteAdminEntry<Data>): Data =>
        present(
            siteAdminFormDefaults(
                descriptor(),
                projectStoredFields(
                    descriptor().fields,
                    resolveTranslation(entry, toValue(context.locale)).data,
                ) as Partial<Data>,
            ),
        )
    const storedValue = (value: Record<string, unknown>) => {
        const fields = (context.descriptor.value ?? cachedDescriptor)?.fields
        // An unloaded descriptor cannot decide which trusted draft fields to discard.
        return present(fields ? projectStoredFields(fields, value) : value)
    }
    const baseline = shallowRef(
        stored ? serialize(storedValue(stored.baseline)) : serialize(initial ? entryValue(initial) : defaultValue()),
    )
    let switching = false
    let intent: { kind: 'save' | 'publish' | 'schedule'; at?: string } = { kind: 'save' }
    let published: SiteAdminEntryMutation<Data> | undefined
    let publishing: Promise<SiteAdminEntryMutation<Data> | undefined> | undefined
    let ensuring = false
    let ensurePending: Promise<{ id: string; version: number } | undefined> | undefined
    const submitting = shallowRef(false)
    const completed = shallowRef(false)
    const uploading = shallowRef(false)
    const operation = computed(() =>
        uploading.value ? 'upload' : submitting.value && !completed.value ? intent.kind : null,
    )
    const form = useForm({
        defaultValues: stored ? storedValue(stored.value) : initial ? entryValue(initial) : defaultValue(),
        validators: [
            {
                run: {
                    '~standard': {
                        version: 1,
                        vendor: 'site-admin',
                        validate: (value: unknown) => descriptorSchema<Data>(descriptor())['~standard'].validate(value),
                    },
                },
                triggers: [],
            },
        ],
        onSubmit: async ({ value, createValidationError }) => {
            if (lifetime.signal.aborted) return
            const identity = draftKey()
            const submitted = clone(serialize(value))
            const selectedIntent = { ...intent }
            let creationDrafts: Array<[string, import('./model').SiteAdminSessionDraft]> = []
            const clearCreatedDrafts = () => {
                for (const [key, draft] of creationDrafts)
                    if (siteAdminSnapshot(context.drafts[key]) === siteAdminSnapshot(draft)) delete context.drafts[key]
            }
            if (selectedIntent.kind !== 'save' && !entryId.value) pendingPublication = true
            try {
                if (!context.descriptor.value || (context.id.value && !currentEntry() && !entryId.value))
                    throw (
                        resource.error.value ??
                        new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Load the entry before submitting.', 400)
                    )
                await options.onBeforeSubmit?.({
                    operation: selectedIntent.kind,
                    ...(toValue(context.locale) ? { locale: toValue(context.locale)! } : {}),
                    ...((currentEntry()?.defaultLocale ?? context.defaultLocale)
                        ? { defaultLocale: currentEntry()?.defaultLocale ?? context.defaultLocale! }
                        : {}),
                })
                lifetime.signal.throwIfAborted()
                if (
                    resource.error.value?.data?.committed &&
                    resource.error.value.data.code === 'SITE_ADMIN_INVALID_RESPONSE'
                )
                    throw resource.error.value
                if (
                    resource.error.value?.data?.code === 'SITE_ADMIN_CONFLICT' ||
                    (currentEntry() && version.value !== currentEntry()!.version)
                )
                    throw new SiteAdminClientError(
                        'SITE_ADMIN_CONFLICT',
                        'Reload the current entry before saving.',
                        409,
                    )
                remember()
                if (!currentEntry())
                    creationDrafts = clone(
                        Object.entries(context.drafts).filter(([key]) => draftGroup(key) === draftGroup(identity)),
                    )
                const result = await context.submit(
                    selectedIntent.kind,
                    value,
                    selectedIntent.at,
                    () => {
                        if (
                            identity !== draftKey() ||
                            siteAdminSnapshot(submitted) !== siteAdminSnapshot(serialize(form.state.values))
                        )
                            throw new SiteAdminClientError(
                                'SITE_ADMIN_CONFLICT',
                                'Input changed during preparation. Your edits are kept.',
                                409,
                            )
                    },
                    newSnapshot(value),
                )
                if (!result || lifetime.signal.aborted || identity !== draftKey()) return
                const edited = clone(serialize(form.state.values))
                clearCreatedDrafts()
                pendingPublication = false
                entryId.value = result.id
                version.value = result.version
                const saved = 'data' in result ? (result as SiteAdminEntry<Data>) : undefined
                baseline.value = saved ? serialize(entryValue(saved)) : submitted
                switching = true
                form.reset(present(baseline.value))
                // Preserve edits made while the request was in flight, including nested field changes.
                for (const name of new Set([...Object.keys(submitted), ...Object.keys(edited)]))
                    if (siteAdminSnapshot(submitted[name]) !== siteAdminSnapshot(edited[name]))
                        setFieldValue(name, present(edited)[name])
                switching = false
                remember()
                published = result
                completed.value = true
                try {
                    if (!ensuring) await options.onSuccess?.(result, { operation: selectedIntent.kind })
                } catch (error) {
                    if (!lifetime.signal.aborted && identity === draftKey()) throw context.report(error, true)
                }
                return result
            } catch (cause) {
                if (lifetime.signal.aborted || identity !== draftKey()) return
                if (context.receipt) {
                    entryId.value = context.receipt.id
                    version.value = context.receipt.version
                    if (resource.error.value?.data?.committed && currentEntry()) {
                        clearCreatedDrafts()
                        baseline.value = serialize(entryValue(currentEntry()!))
                        pendingPublication = false
                    }
                    remember()
                }
                const error = context.report(
                    cause,
                    Boolean((cause as { data?: { committed?: boolean } })?.data?.committed),
                )
                const issues = error.data?.issues ?? []
                const fields = Object.fromEntries(
                    issues.map(({ message, path }) => [path.replace(/^data\./u, ''), message]),
                )
                return createValidationError({ fields: fields as never, form: error.message })
            }
        },
    })
    const setFieldValue = (form as unknown as { setFieldValue: (name: string, value: unknown) => void }).setFieldValue
    const values = shallowRef(form.state.values)
    const subscription = form.atom.subscribe((state) => {
        if (state.isSubmitting && !submitting.value) completed.value = false
        submitting.value = state.isSubmitting
        values.value = state.values
    })
    const isDirty = computed(() => siteAdminSnapshot(serialize(values.value)) !== siteAdminSnapshot(baseline.value))
    function remember() {
        if (switching) return
        if (!isDirty.value && !pendingPublication && !(toValue(context.instance) !== undefined && entryId.value)) {
            delete context.drafts[storedKey]
            return
        }
        context.drafts[storedKey] = clone({
            value: serialize(form.state.values),
            baseline: baseline.value,
            ...(storedLocale ? { locale: storedLocale } : {}),
            entryId: entryId.value,
            version: version.value,
            ...(pendingPublication ? { pendingPublication: true } : {}),
        })
    }
    watch(values, remember, { deep: true, flush: 'sync' })
    watch(
        () => toValue(context.identity),
        (next, previous) => {
            let authChanged = false
            try {
                authChanged =
                    JSON.parse(next.slice('site-admin-management:'.length))[2] !==
                    JSON.parse(previous.slice('site-admin-management:'.length))[2]
            } catch {}
            if (!authChanged) remember()
            // An identity switch must never display the previous actor's input.
            switching = true
            storedKey = draftKey()
            storedLocale = toValue(context.locale) ?? context.defaultLocale
            const restored = context.drafts[storedKey]
            pendingPublication = restored?.pendingPublication ?? false
            entryId.value = restored?.entryId ?? null
            version.value = restored?.version ?? null
            if (entryId.value) context.id.value = entryId.value
            const fallback = currentEntry() ? entryValue(currentEntry()!) : newDefaultValue()
            baseline.value = restored?.baseline ?? serialize(fallback)
            form.reset(restored ? present(restored.value) : fallback)
            switching = false
        },
        { flush: 'sync' },
    )
    watch(
        [resource.data, resource.status],
        () => {
            const current = currentEntry()
            if (!current || form.state.isSubmitting) return
            if (isDirty.value) {
                if (resource.status.value === 'success' && version.value !== null && version.value !== current.version)
                    context.report(
                        new SiteAdminClientError(
                            'SITE_ADMIN_CONFLICT',
                            'The saved entry changed. Your input is kept.',
                            409,
                        ),
                    )
                return
            }
            entryId.value = current.id
            version.value = current.version
            baseline.value = serialize(entryValue(current))
            form.reset(entryValue(current))
            remember()
        },
        { immediate: true, flush: 'sync' },
    )
    watch(
        context.descriptor,
        (value, previous) => {
            if (!value || previous) return
            if (!currentEntry() && !context.id.value && !isDirty.value) {
                baseline.value = serialize(defaultValue())
                form.reset(defaultValue())
            } else {
                baseline.value = serialize(storedValue(baseline.value))
                form.reset(storedValue(form.state.values))
            }
        },
        { flush: 'sync' },
    )
    if (getCurrentScope())
        onScopeDispose(() => {
            remember()
            subscription.unsubscribe()
        })
    const publish = (at?: string): Promise<SiteAdminEntryMutation<Data> | undefined> => {
        if (publishing) return intent.at === at ? publishing : publishing.then(() => publish(at))
        if (form.state.isSubmitting) {
            context.report(
                new SiteAdminClientError('SITE_ADMIN_CONFLICT', 'Wait for the current save before publishing.', 409),
            )
            return Promise.resolve(undefined)
        }
        intent = at === undefined ? { kind: 'publish' } : { kind: 'schedule', at }
        published = undefined
        publishing = (async () => {
            try {
                await form.handleSubmit()
                return published
            } finally {
                intent = { kind: 'save' }
                publishing = undefined
            }
        })()
        return publishing
    }
    let uploadSequence = 0
    const uploadIds = new WeakMap<File, number>()
    const uploadTarget = (path: string) => {
        const invalid = () =>
            new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Select an existing asset field.', 400)
        if (!/^[^.[\]]+(?:\.[^.[\]]+|\[(?:0|[1-9]\d*)\])*$/u.test(path)) throw invalid()
        let definition: FieldDescriptor | undefined
        let fields = descriptor().fields
        let value: unknown = form.state.values
        const rows: unknown[] = []
        for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/gu)) {
            if (match[2] !== undefined) {
                const index = Number(match[2])
                if (definition?.kind !== 'array' || !Array.isArray(value) || !Object.hasOwn(value, index))
                    throw invalid()
                definition = definition.item
                value = value[index]
                rows.push(toRaw(value))
            } else {
                const key = match[1]!
                if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid()
                if (definition) {
                    if (definition.kind !== 'object') throw invalid()
                    fields = definition.fields ?? {}
                }
                if (!Object.hasOwn(fields, key)) throw invalid()
                definition = fields[key]
                value = isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined
            }
            if (!definition) throw invalid()
        }
        if (!definition || !['image', 'images', 'file'].includes(definition.kind)) throw invalid()
        return { definition, rows, value }
    }
    const fieldPriority = (field: { key: string; kind: string }) =>
        field.key === (context.descriptor.value?.displayFields?.title ?? 'title')
            ? 0
            : ['image', 'images'].includes(field.kind)
              ? 1
              : 2
    const result = {
        form,
        operation: readonly(operation),
        fields: computed(() =>
            Object.entries(context.descriptor.value?.fields ?? {})
                .map(([key, field]) => ({
                    ...field,
                    key,
                    name: key as Extract<keyof Data, string>,
                    label:
                        field.label ??
                        key.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/^./u, (letter) => letter.toUpperCase()),
                }))
                .sort((a, b) => fieldPriority(a) - fieldPriority(b)),
        ),
        publish: () => publish(),
        schedule: (value: Date | string) => {
            const at = new Date(value)
            if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
                context.report(
                    new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Choose a future publication time.', 400),
                )
                return Promise.resolve(undefined)
            }
            return publish(at.toISOString())
        },
        upload: (field: DeepKeys<Data>, files: File | File[] | null | undefined) => {
            if (lifetime.signal.aborted) return Promise.resolve(undefined)
            const selected = files ? (Array.isArray(files) ? files : [files]) : []
            if (!selected.length) return Promise.resolve([])
            let target: ReturnType<typeof uploadTarget>
            try {
                target = uploadTarget(field)
            } catch (cause) {
                context.report(cause)
                return Promise.resolve(undefined)
            }
            const currentTarget = () => {
                const current = uploadTarget(field)
                if (current.rows.some((row, index) => row !== target.rows[index]))
                    throw new SiteAdminClientError(
                        'SITE_ADMIN_CONFLICT',
                        'The upload target changed. Select the image again.',
                        409,
                    )
                return current
            }
            const token = selected
                .map((file) => {
                    if (!uploadIds.has(file)) uploadIds.set(file, ++uploadSequence)
                    return uploadIds.get(file)
                })
                .join(',')
            return context
                .run(
                    'upload:' + field + ':' + token,
                    async (signal) => {
                        uploading.value = true
                        try {
                            const { definition } = currentTarget()
                            const identity = toValue(context.identity)
                            const records = []
                            for (const file of definition.kind === 'images' ? selected : selected.slice(0, 1)) {
                                const asset = siteAdminAsset(
                                    await context.client.uploadAsset(file, { filename: file.name, signal }),
                                    (id) => context.client.assetUrl(id),
                                )
                                signal.throwIfAborted()
                                lifetime.signal.throwIfAborted()
                                if (identity !== toValue(context.identity))
                                    throw new DOMException('Resource identity changed during upload.', 'AbortError')
                                records.push(asset)
                                const current = currentTarget().value
                                setFieldValue(
                                    field,
                                    definition.kind === 'images'
                                        ? [...(Array.isArray(current) ? current : []), asset]
                                        : asset,
                                )
                                target = uploadTarget(field)
                            }
                            signal.throwIfAborted()
                            lifetime.signal.throwIfAborted()
                            try {
                                await options.onUpload?.({
                                    field,
                                    files: definition.kind === 'images' ? selected : selected.slice(0, 1),
                                    assets: records,
                                })
                            } catch (cause) {
                                if (!lifetime.signal.aborted && identity === toValue(context.identity))
                                    context.report(cause, true)
                            }
                            return records
                        } finally {
                            uploading.value = false
                        }
                    },
                    false,
                )
                .catch(() => undefined)
        },
        draft: {
            ensure: () => {
                if (ensurePending) return ensurePending
                if (entryId.value && version.value !== null)
                    return Promise.resolve({ id: entryId.value, version: version.value })
                ensuring = true
                ensurePending = (async () => {
                    try {
                        await form.handleSubmit()
                        return !resource.error.value && entryId.value && version.value !== null
                            ? { id: entryId.value, version: version.value }
                            : undefined
                    } finally {
                        ensuring = false
                        ensurePending = undefined
                    }
                })()
                return ensurePending
            },
            isDirty: computed(
                () =>
                    isDirty.value ||
                    Object.entries(context.drafts).some(
                        ([key, draft]) =>
                            draftGroup(key) === draftGroup(draftKey()) &&
                            siteAdminSnapshot(draft.value) !== siteAdminSnapshot(draft.baseline),
                    ),
            ),
            snapshot: () =>
                clone({
                    entryId: entryId.value,
                    version: version.value,
                    locale: toValue(context.locale),
                    draft: serialize(values.value),
                }),
            isStale: (snapshot: unknown) =>
                siteAdminSnapshot(snapshot) !==
                siteAdminSnapshot({
                    entryId: entryId.value,
                    version: version.value,
                    locale: toValue(context.locale),
                    draft: serialize(values.value),
                }),
            discard: async () => {
                delete context.drafts[storedKey]
                form.reset(present(baseline.value))
                await resource.refresh()
            },
        },
    }
    const setupUnload = () => {
        if (typeof window === 'undefined') return () => {}
        const handler = (event: BeforeUnloadEvent) => event.preventDefault()
        const stop = watch(
            () =>
                options.beforeUnload !== false &&
                (result.draft.isDirty.value || operation.value !== null || toValue(options.beforeUnload) === true),
            (active) => window[active ? 'addEventListener' : 'removeEventListener']('beforeunload', handler),
            { immediate: true, flush: 'sync' },
        )
        return () => {
            stop()
            window.removeEventListener('beforeunload', handler)
        }
    }
    if (getCurrentInstance()) {
        let cleanup: (() => void) | undefined
        onMounted(() => {
            cleanup = setupUnload()
        })
        onScopeDispose(() => cleanup?.())
    }
    return result
}
