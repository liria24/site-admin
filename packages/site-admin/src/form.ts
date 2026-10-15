import type { StandardSchemaV1 } from '@standard-schema/spec'
import { useForm } from '@tanstack/vue-form'
import { computed, getCurrentScope, onScopeDispose, shallowRef, toRaw, toValue, watch } from 'vue'
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
    defaultValues?: Partial<Data>
    onSuccess?: (entry: SiteAdminEntryMutation<Data>) => void | Promise<void>
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
    const context = resource[siteAdminModelContext]
    let cachedDescriptor = context.descriptor.value
    const descriptor = () => {
        cachedDescriptor = context.descriptor.value ?? cachedDescriptor
        if (!cachedDescriptor) throw new Error('[site-admin] Await useAdminEntry before creating its form.')
        return cachedDescriptor
    }
    const present = (data: Record<string, unknown>) =>
        presentSiteAdminData<Data>(descriptor(), data, (id) => context.client.assetUrl(id))
    const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value
    const serialize = (value: Data) => serializeSiteAdminData(descriptor(), value)
    const currentEntry = () => (resource.data.value && 'id' in resource.data.value ? resource.data.value : null)
    const initial = currentEntry()
    const draftKey = () => toValue(context.identity)
    let storedKey = draftKey()
    const stored = context.drafts[storedKey]
    let pendingPublication = stored?.pendingPublication ?? false
    const version = shallowRef(stored ? stored.version : (initial?.version ?? null))
    const entryId = shallowRef(initial?.id ?? stored?.entryId ?? null)
    // A new route can resume the draft created while running an app-owned AI action.
    if (entryId.value) context.id.value = entryId.value
    const defaultValue = (): Data => present(siteAdminFormDefaults(descriptor(), options.defaultValues))
    const entryValue = (entry: SiteAdminEntry<Data>): Data =>
        present(
            siteAdminFormDefaults(descriptor(), projectStoredFields(descriptor().fields, entry.data) as Partial<Data>),
        )
    const storedValue = (value: Record<string, unknown>) => present(projectStoredFields(descriptor().fields, value))
    const baseline = shallowRef(
        stored ? serialize(storedValue(stored.baseline)) : serialize(initial ? entryValue(initial) : defaultValue()),
    )
    let switching = false
    let intent: { kind: 'save' | 'publish' | 'schedule'; at?: string } = { kind: 'save' }
    let published: SiteAdminEntryMutation<Data> | undefined
    let publishing: Promise<SiteAdminEntryMutation<Data> | undefined> | undefined
    const form = useForm({
        defaultValues: stored ? storedValue(stored.value) : initial ? entryValue(initial) : defaultValue(),
        validators: [{ run: descriptorSchema<Data>(descriptor()), triggers: [] }],
        onSubmit: async ({ value, createValidationError }) => {
            const identity = draftKey()
            const submitted = clone(serialize(value))
            const selectedIntent = { ...intent }
            if (selectedIntent.kind !== 'save' && !entryId.value) pendingPublication = true
            try {
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
                const result = await context.submit(selectedIntent.kind, value, selectedIntent.at, () => {
                    if (
                        identity !== draftKey() ||
                        siteAdminSnapshot(submitted) !== siteAdminSnapshot(serialize(form.state.values))
                    )
                        throw new SiteAdminClientError(
                            'SITE_ADMIN_CONFLICT',
                            'Input changed during preparation. Your edits are kept.',
                            409,
                        )
                })
                if (!result || identity !== draftKey()) return
                const edited = clone(serialize(form.state.values))
                pendingPublication = false
                entryId.value = result.id
                version.value = result.version
                const saved = 'data' in result ? (result as SiteAdminEntry<Data>) : undefined
                baseline.value = saved ? serialize(saved.data) : submitted
                switching = true
                form.reset(present(baseline.value))
                // Preserve edits made while the request was in flight, including nested field changes.
                for (const name of new Set([...Object.keys(submitted), ...Object.keys(edited)]))
                    if (siteAdminSnapshot(submitted[name]) !== siteAdminSnapshot(edited[name]))
                        setFieldValue(name, present(edited)[name])
                switching = false
                remember()
                published = result
                try {
                    await options.onSuccess?.(result)
                } catch (error) {
                    if (identity === draftKey()) throw context.report(error, true)
                }
                return result
            } catch (cause) {
                if (identity !== draftKey()) return
                if (context.receipt) {
                    entryId.value = context.receipt.id
                    version.value = context.receipt.version
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
        values.value = state.values
    })
    const isDirty = computed(() => siteAdminSnapshot(serialize(values.value)) !== siteAdminSnapshot(baseline.value))
    function remember() {
        if (switching) return
        if (!isDirty.value && !pendingPublication) {
            delete context.drafts[storedKey]
            return
        }
        context.drafts[storedKey] = clone({
            value: serialize(form.state.values),
            baseline: baseline.value,
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
            const restored = context.drafts[storedKey]
            pendingPublication = restored?.pendingPublication ?? false
            entryId.value = restored?.entryId ?? null
            version.value = restored?.version ?? null
            baseline.value = restored?.baseline ?? {}
            form.reset(restored ? present(restored.value) : ({} as Data))
            switching = false
        },
        { flush: 'sync' },
    )
    watch(
        resource.data,
        () => {
            const current = currentEntry()
            if (!current || form.state.isSubmitting) return
            if (isDirty.value) {
                if (version.value !== null && version.value !== current.version)
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
        { immediate: true },
    )
    if (getCurrentScope())
        onScopeDispose(() => {
            remember()
            subscription.unsubscribe()
        })
    const publish = (at?: string): Promise<SiteAdminEntryMutation<Data> | undefined> => {
        if (publishing) return intent.at === at ? publishing : publishing.then(() => publish(at))
        if (form.state.isSubmitting)
            return Promise.reject(
                context.report(
                    new SiteAdminClientError(
                        'SITE_ADMIN_CONFLICT',
                        'Wait for the current save before publishing.',
                        409,
                    ),
                ),
            )
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
    const fieldPriority = (field: { key: string; kind: string }) =>
        field.key === (context.descriptor.value?.displayFields?.title ?? 'title')
            ? 0
            : ['image', 'images'].includes(field.kind)
              ? 1
              : 2
    return {
        form,
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
        schedule: (at: string) => publish(at),
        upload: (field: Extract<keyof Data, string>, files: File | File[] | null | undefined) => {
            const selected = files ? (Array.isArray(files) ? files : [files]) : []
            if (!selected.length) return Promise.resolve([])
            const token = selected
                .map((file) => {
                    if (!uploadIds.has(file)) uploadIds.set(file, ++uploadSequence)
                    return uploadIds.get(file)
                })
                .join(',')
            return context.run(
                'upload:' + field + ':' + token,
                async () => {
                    const key = field
                    const definition = descriptor().fields[key]
                    if (!definition || !['image', 'images', 'file'].includes(definition.kind))
                        throw new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Select an asset field.', 400)
                    const identity = toValue(context.identity)
                    const records = []
                    for (const file of definition.kind === 'images' ? selected : selected.slice(0, 1)) {
                        const asset = siteAdminAsset(await context.client.uploadAsset(file), (id) =>
                            context.client.assetUrl(id),
                        )
                        if (identity !== toValue(context.identity))
                            throw new DOMException('Resource identity changed during upload.', 'AbortError')
                        records.push(asset)
                        const current = form.state.values[key]
                        setFieldValue(
                            field,
                            definition.kind === 'images' ? [...(Array.isArray(current) ? current : []), asset] : asset,
                        )
                    }
                    return records
                },
                false,
            )
        },
        draft: {
            isDirty,
            snapshot: () => clone({ entryId: entryId.value, version: version.value, draft: serialize(values.value) }),
            isStale: (snapshot: unknown) =>
                siteAdminSnapshot(snapshot) !==
                siteAdminSnapshot({ entryId: entryId.value, version: version.value, draft: serialize(values.value) }),
            discard: async () => {
                delete context.drafts[storedKey]
                form.reset(present(baseline.value))
                await resource.refresh()
            },
        },
    }
}
