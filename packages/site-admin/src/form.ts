import type { StandardSchemaV1 } from '@standard-schema/spec'
import { useForm } from '@tanstack/vue-form'
import {
    computed,
    getCurrentScope,
    onScopeDispose,
    ref,
    shallowRef,
    toRaw,
    toValue,
    watch,
    type MaybeRefOrGetter,
    type Ref,
} from 'vue'

import { createSiteAdminManagementClient, SiteAdminClientError } from './client'
import type { SiteAdminDraftProposal, SiteAdminEntryMutation, SiteAdminManagementClient } from './client'
import { presentSiteAdminData, serializeSiteAdminData, siteAdminAsset, type SiteAdminAsset } from './management-assets'
import type { FieldDescriptor, ModelDescriptor } from './descriptor'
import type { SiteAdminIssue } from './errors'
import type { AssetRecord, EntryRecord } from './server/types'
import { validateAsset } from './validation'

export interface SiteAdminFormError {
    code: string
    issues?: SiteAdminIssue[]
    message: string
}

export interface UseSiteAdminFormOptions<Data extends Record<string, unknown>> {
    defaultValues?: Partial<Data>
    descriptor: ModelDescriptor
    entry?: EntryRecord
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    locale?: MaybeRefOrGetter<string | undefined>
    managementBase?: string
    modelName: string
    origin?: string
    onSuccess?: (entry: SiteAdminEntryMutation<Data>) => Promise<void> | void
    /** Optional controlled slug source; omit to edit controller.slug directly. */
    slug?: MaybeRefOrGetter<string | undefined>
    id?: MaybeRefOrGetter<string | null | undefined>
    authScope?: MaybeRefOrGetter<string>
    key?: string
    /** Optional request/app-scoped session store. Never writes to storage or the database. */
    drafts?: Record<string, SiteAdminSessionDraft>
    /** Nuxt supplies the initial raw response without applying user transform/pick options. */
    initialEntry?: EntryRecord
    client?: SiteAdminManagementClient<Record<string, Record<string, unknown>>>
    presentation?: boolean
    /** @deprecated Saves never invoke AI. Select an explicit ai.run action instead. */
    generateMetadataOnSubmit?: boolean
    loadDescriptor?: (signal: AbortSignal) => Promise<ModelDescriptor>
    loadEntry?: (id: string, signal: AbortSignal) => Promise<EntryRecord>
}

export interface SiteAdminSessionDraft {
    data: Record<string, unknown>
    baseline: Record<string, unknown>
    baseSlug: string
    slug: string
    entryId: string | null
    baseVersion: number | null
    metadata: { slug: 'auto' | 'manual'; excerpt: 'auto' | 'manual' }
}

export { presentSiteAdminData, serializeSiteAdminData }
export type { SiteAdminAsset }

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
): StandardSchemaV1.Issue[] => {
    const issues: StandardSchemaV1.Issue[] = []
    for (const [name, field] of Object.entries(fields)) {
        const path = [parent, name].filter(Boolean).join('.')
        const value = data[name]
        const add = (message: string): void => void issues.push({ message, path: path.split('.') })
        if (value === undefined || value === null) {
            if (field.required) add('Required.')
            continue
        }
        if (field.kind === 'object') {
            if (typeof value !== 'object' || Array.isArray(value)) add('Must be an object.')
            else issues.push(...descriptorIssues(field.fields ?? {}, value as Record<string, unknown>, path))
        } else if (field.kind === 'array' || field.kind === 'images') {
            if (!Array.isArray(value)) add('Must be an array.')
            else {
                if (field.minItems !== undefined && value.length < field.minItems)
                    add(`Minimum ${field.minItems} items.`)
                if (field.maxItems !== undefined && value.length > field.maxItems)
                    add(`Maximum ${field.maxItems} items.`)
                if (field.kind === 'images')
                    for (const [index, item] of value.entries())
                        issues.push(
                            ...validateAsset(item, `${path}.${index}`).map((issue) => ({
                                message: issue.message,
                                path: issue.path.split('.'),
                            })),
                        )
                else if (field.item)
                    for (const [index, item] of value.entries())
                        issues.push(...descriptorIssues({ [index]: field.item }, { [index]: item }, path))
            }
        } else if (field.kind === 'image' || field.kind === 'file') {
            for (const issue of validateAsset(value, path)) add(issue.message)
        } else if (field.kind === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) add('Must be a finite number.')
            else if (field.min !== undefined && value < field.min) add(`Must be at least ${field.min}.`)
            else if (field.max !== undefined && value > field.max) add(`Must be at most ${field.max}.`)
        } else if (field.kind === 'boolean') {
            if (typeof value !== 'boolean') add('Must be a boolean.')
        } else if (field.kind === 'select') {
            if (typeof value !== 'string' || !field.values?.includes(value)) add('Select a supported value.')
        } else if (typeof value !== 'string') add('Must be a string.')
        else if (field.minLength !== undefined && value.length < field.minLength)
            add(`Minimum ${field.minLength} characters.`)
        else if (field.maxLength !== undefined && value.length > field.maxLength)
            add(`Maximum ${field.maxLength} characters.`)
    }
    return issues
}

const descriptorSchema = <Data extends Record<string, unknown>>(
    model: ModelDescriptor,
): StandardSchemaV1<Data, Data> => ({
    '~standard': {
        validate: (value) => {
            const data = value as Data
            const issues = descriptorIssues(model.fields, data)
            return issues.length > 0 ? { issues } : { value: data }
        },
        vendor: 'site-admin',
        version: 1,
    },
})

const uploadWithProgress = (url: string, file: File, progress: Ref<number | null>): Promise<AssetRecord> =>
    new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', url)
        xhr.withCredentials = true
        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) progress.value = event.loaded / event.total
        })
        xhr.addEventListener('load', () => {
            let payload: AssetRecord | { error?: SiteAdminFormError } | null
            try {
                payload = JSON.parse(xhr.responseText || 'null') as typeof payload
            } catch {
                reject(new Error(`Upload returned an invalid response (${xhr.status}).`))
                return
            }
            if (xhr.status >= 200 && xhr.status < 300 && payload && 'id' in payload) resolve(payload)
            else
                reject(
                    new Error(
                        payload && 'error' in payload ? payload.error?.message : `Upload failed (${xhr.status}).`,
                    ),
                )
        })
        xhr.addEventListener('error', () => reject(new Error('Upload failed.')))
        xhr.setRequestHeader('x-filename', encodeURIComponent(file.name))
        xhr.setRequestHeader('x-upload-size', String(file.size))
        xhr.send(file)
    })

export const useSiteAdminForm = <
    Data extends Record<string, unknown>,
    Action extends string = string,
    RawData extends Record<string, unknown> = Data,
>(
    options: UseSiteAdminFormOptions<Data>,
) => {
    const basePath = `/${(options.managementBase ?? '/api/site-admin').split('/').filter(Boolean).join('/')}`
    const base = `${options.origin?.replace(/\/$/u, '') ?? ''}${basePath}`
    const client =
        options.client ??
        createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
            basePath,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
        })
    const descriptor = shallowRef(options.descriptor)
    const suppliedInitial = options.initialEntry ?? options.entry
    const initial =
        options.id === undefined || suppliedInitial?.id === toValue(options.id) ? suppliedInitial : undefined
    const entryId = ref(initial?.id ?? toValue(options.id) ?? null)
    const version = ref(initial?.version ?? null)
    const hasSlugInput = 'slug' in options
    const slug = ref(toValue(options.slug) ?? initial?.slug ?? '')
    const defaultMetadata = (): SiteAdminSessionDraft['metadata'] => ({ slug: 'manual', excerpt: 'manual' })
    const metadata = ref<SiteAdminSessionDraft['metadata']>(
        initial ? { slug: 'manual', excerpt: 'manual' } : defaultMetadata(),
    )
    const drafts = options.drafts ?? (Object.create(null) as Record<string, SiteAdminSessionDraft>)
    const assetUrl = (id: string) => client.assetUrl(id)
    const present = (data: Record<string, unknown>): Data =>
        options.presentation ? presentSiteAdminData<Data>(descriptor.value, data, assetUrl) : (data as Data)
    const serialize = (data: Record<string, unknown>): Record<string, unknown> =>
        serializeSiteAdminData(descriptor.value, data)
    const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value
    const canonical = (value: unknown): string =>
        JSON.stringify(value, (_name, item: unknown) =>
            item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
                : item,
        )
    const sourceId = () => (options.id === undefined ? (options.entry?.id ?? null) : (toValue(options.id) ?? null))
    const sourceIdentity = computed(() =>
        JSON.stringify([
            base,
            toValue(options.authScope) ?? '',
            options.modelName,
            toValue(options.locale) ?? '',
            sourceId(),
            sourceId() === null ? (options.key ?? 'new') : null,
        ]),
    )
    const identity = ref(sourceIdentity.value)
    const baseline = shallowRef(
        serialize(present(siteAdminFormDefaults(descriptor.value, initial?.data ?? options.defaultValues))),
    )
    let baseSlug = slug.value
    const serverError = ref<SiteAdminFormError | null>(null)
    const conflict = ref(false)
    const loading = ref(false)
    const loadError = shallowRef<unknown>(null)
    const callbackError = shallowRef<unknown>(null)
    let loadRequest: AbortController | undefined
    let generation = 0
    let aiRequest: AbortController | undefined
    let switching = false
    let authorized = true
    const uploadProgress = ref<number | null>(null)
    const uploadError = ref<string | null>(null)
    let submitIntent: 'save' | 'publish' | 'schedule' = 'save'
    let scheduleAt: string | undefined
    let publishedResult: SiteAdminEntryMutation<Data> | undefined
    let publishing: Promise<SiteAdminEntryMutation<Data> | undefined> | undefined
    const publishBusy = ref(false)
    const form = useForm({
        defaultValues: present(siteAdminFormDefaults(descriptor.value, initial?.data ?? options.defaultValues)),
        validators: [
            {
                run: {
                    '~standard': {
                        vendor: 'site-admin',
                        version: 1 as const,
                        validate: (value: unknown) => {
                            return descriptorSchema<Data>(descriptor.value)['~standard'].validate(value)
                        },
                    },
                },
                triggers: [],
            },
        ],
        onSubmit: async ({ createValidationError, parseIssues, value }) => {
            serverError.value = null
            callbackError.value = null
            conflict.value = false
            if (!authorized || loading.value || loadError.value)
                return createValidationError({ fields: {}, form: 'Load the current entry before saving.' })
            const intent = submitIntent
            const submittedIdentity = identity.value
            const submittedVersion = version.value
            const submittedId = entryId.value
            // Core callers have always been able to supply a getter evaluated at submission.
            const submittedSlug = hasSlugInput ? toValue(options.slug) : slug.value
            if (hasSlugInput) slug.value = submittedSlug ?? ''
            const submittedInputSlug = slug.value
            const submittedLocale = toValue(options.locale)
            const submittedData = clone(serialize(value))
            const submittedInputData = clone(submittedData)
            const updating = entryId.value !== null
            let entry: SiteAdminEntryMutation<Record<string, unknown>>
            try {
                const input = {
                    data: submittedData,
                    ...(hasSlugInput
                        ? submittedSlug === undefined
                            ? {}
                            : { slug: submittedSlug }
                        : { slug: submittedSlug ?? '' }),
                }
                if (
                    intent !== 'save' &&
                    (!submittedId ||
                        submittedVersion === null ||
                        aiBusy.value ||
                        aiStale.value ||
                        aiError.value ||
                        conflict.value)
                )
                    throw new SiteAdminClientError(
                        'SITE_ADMIN_CONFLICT',
                        'Save a current draft and apply or discard pending AI proposals before publishing.',
                        409,
                    )
                entry =
                    intent === 'publish'
                        ? await client.publishEntry(submittedId!, { expectedVersion: submittedVersion!, draft: input })
                        : intent === 'schedule'
                          ? await client.schedulePublish(submittedId!, {
                                expectedVersion: submittedVersion!,
                                at: scheduleAt!,
                                draft: input,
                            })
                          : updating
                            ? await client.updateEntry(submittedId!, { ...input, expectedVersion: submittedVersion! })
                            : await client.createEntry(options.modelName, {
                                  ...input,
                                  ...(submittedLocale ? { locale: submittedLocale } : {}),
                              })
            } catch (cause) {
                const error: SiteAdminFormError = {
                    code: cause instanceof SiteAdminClientError ? cause.code : 'SITE_ADMIN_REQUEST_FAILED',
                    ...(cause instanceof SiteAdminClientError && cause.issues ? { issues: cause.issues } : {}),
                    message: cause instanceof Error ? cause.message : 'Save failed.',
                }
                if (identity.value !== submittedIdentity) return
                serverError.value = error
                conflict.value = error.code === 'SITE_ADMIN_CONFLICT'
                if (error.issues?.length) {
                    const parsed = parseIssues(
                        error.issues.map((issue) => ({ message: issue.message, path: issue.path.split('.') })),
                    )
                    return createValidationError({ fields: parsed.fields, form: error.message })
                }
                return createValidationError({ fields: {}, form: error.message })
            }
            const result: SiteAdminEntryMutation<Data> =
                'data' in entry ? { ...entry, data: present(entry.data) } : entry
            const currentIdentity = identity.value === submittedIdentity
            if (currentIdentity) {
                const currentData = clone(serialize(form.state.values))
                const currentSlug = slug.value
                const editedDuringSave =
                    canonical(currentData) !== canonical(submittedInputData) || currentSlug !== submittedInputSlug
                switching = true
                entryId.value = entry.id
                version.value = entry.version
                slug.value = 'slug' in entry ? entry.slug : (submittedSlug ?? '')
                baseline.value = serialize('data' in result ? result.data : value)
                baseSlug = slug.value
                form.reset(present(baseline.value))
                if (editedDuringSave) {
                    const edited = present(currentData)
                    for (const name of new Set([...Object.keys(submittedInputData), ...Object.keys(currentData)]))
                        if (canonical(currentData[name]) !== canonical(submittedInputData[name]))
                            form.setFieldValue(name as never, edited[name] as never)
                    if (currentSlug !== submittedInputSlug) slug.value = currentSlug
                }
                conflict.value = false
                discardProposal()
                if (!updating) {
                    delete drafts[submittedIdentity]
                    identity.value = JSON.stringify([
                        base,
                        toValue(options.authScope) ?? '',
                        options.modelName,
                        toValue(options.locale) ?? '',
                        entry.id,
                        null,
                    ])
                }
                switching = false
                remember()
            }
            if (currentIdentity) {
                try {
                    await options.onSuccess?.(result)
                } catch (error) {
                    callbackError.value = error
                }
            }
            if (intent !== 'save' && currentIdentity) publishedResult = result
            return result
        },
    })
    const values = shallowRef(form.state.values)
    const valueSubscription = form.atom.subscribe((state) => {
        values.value = state.values
    })
    const dirty = computed(
        () => canonical(serialize(values.value)) !== canonical(baseline.value) || slug.value !== baseSlug,
    )
    const remember = (): void => {
        if (switching || !authorized) return
        drafts[identity.value] = clone({
            data: serialize(form.state.values),
            baseline: baseline.value,
            baseSlug,
            slug: slug.value,
            entryId: entryId.value,
            baseVersion: version.value,
            metadata: metadata.value,
        })
    }
    const restore = (draft: SiteAdminSessionDraft): void => {
        switching = true
        baseline.value = draft.baseline
        baseSlug = draft.baseSlug
        entryId.value = draft.entryId
        version.value = draft.baseVersion
        slug.value = draft.slug
        metadata.value = { ...draft.metadata }
        form.reset(present(baseline.value))
        const data = present(draft.data)
        for (const name of new Set([...Object.keys(baseline.value), ...Object.keys(data)]))
            form.setFieldValue(name as never, data[name] as never)
        switching = false
    }
    const validateEntry = (entry: EntryRecord): void => {
        if (
            entry.model !== options.modelName ||
            (toValue(options.locale) !== undefined && entry.locale !== toValue(options.locale))
        )
            throw new SiteAdminClientError(
                'SITE_ADMIN_INVALID_RESPONSE',
                'Entry does not belong to the requested model and locale.',
                502,
            )
    }
    const refresh = async (): Promise<void> => {
        loadRequest?.abort()
        const request = new AbortController()
        loadRequest = request
        const capturedIdentity = identity.value
        const capturedId = entryId.value
        loading.value = true
        loadError.value = null
        try {
            if (options.loadDescriptor) {
                const currentDescriptor = await options.loadDescriptor(request.signal)
                request.signal.throwIfAborted()
                if (identity.value !== capturedIdentity) return
                descriptor.value = currentDescriptor
            }
            authorized = true
            if (capturedId === null) {
                if (!dirty.value) {
                    baseline.value = serialize(present(siteAdminFormDefaults(descriptor.value, options.defaultValues)))
                    form.reset(present(baseline.value))
                    remember()
                }
                return
            }
            const entry = options.loadEntry
                ? await options.loadEntry(capturedId, request.signal)
                : await client.getEntry(capturedId, { signal: request.signal })
            request.signal.throwIfAborted()
            if (identity.value !== capturedIdentity) return
            validateEntry(entry)
            if (dirty.value) {
                if (entry.version !== version.value) conflict.value = true
                return
            }
            baseline.value = serialize(present(entry.data))
            baseSlug = entry.slug
            slug.value = entry.slug
            version.value = entry.version
            form.reset(present(baseline.value))
            remember()
        } catch (error) {
            if (!request.signal.aborted && identity.value === capturedIdentity) loadError.value = error
        } finally {
            if (loadRequest === request) loading.value = false
        }
    }
    const switchIdentity = async (next: string, previous: string): Promise<void> => {
        remember()
        loadRequest?.abort()
        discardProposal()
        identity.value = next
        conflict.value = false
        serverError.value = null
        loadError.value = null
        const authChanged = JSON.parse(next)[1] !== JSON.parse(previous)[1]
        if (authChanged) {
            for (const key of Object.keys(drafts))
                if (JSON.parse(key)[0] === base && JSON.parse(key)[1] === JSON.parse(previous)[1]) delete drafts[key]
            authorized = false
        }
        const draft = drafts[next]
        if (draft) restore(draft)
        else {
            const data = authChanged
                ? ({} as Data)
                : present(siteAdminFormDefaults(descriptor.value, options.defaultValues))
            restore({
                data: serialize(data),
                baseline: serialize(data),
                baseSlug: toValue(options.slug) ?? '',
                slug: toValue(options.slug) ?? '',
                entryId: sourceId(),
                baseVersion: null,
                metadata: sourceId() ? { slug: 'manual', excerpt: 'manual' } : defaultMetadata(),
            })
        }
        await refresh()
    }
    const proposal = shallowRef<SiteAdminDraftProposal<Data> | null>(null)
    const aiBusy = ref<string | null>(null)
    const aiError = shallowRef<unknown>(null)
    const aiStale = ref(false)
    let proposalSnapshot: string | null = null
    const inputSnapshot = () =>
        canonical([identity.value, serialize(values.value), slug.value, metadata.value, version.value])
    const propose = async (kind: string, actionInput?: Record<string, unknown>): Promise<void> => {
        aiRequest?.abort()
        const transportRequest = new AbortController()
        aiRequest = transportRequest
        const request = ++generation
        const snapshot = inputSnapshot()
        const snapshotVersion = version.value
        aiBusy.value = kind
        aiError.value = null
        aiStale.value = false
        proposal.value = null
        try {
            const data = serialize(form.state.values)
            if (actionInput !== undefined && (entryId.value === null || version.value === null))
                throw new SiteAdminClientError(
                    'SITE_ADMIN_INVALID_INPUT',
                    'Save the draft before running an entry action.',
                    400,
                )
            const result = await client.runAIAction(
                entryId.value!,
                kind,
                { expectedVersion: version.value!, draft: { data, slug: slug.value }, input: actionInput ?? {} },
                { signal: transportRequest.signal },
            )
            if (request !== generation) return
            if (transportRequest.signal.aborted || snapshot !== inputSnapshot() || result.version !== snapshotVersion) {
                aiStale.value = true
                return
            }
            proposalSnapshot = snapshot
            proposal.value = { ...result, data: present(result.data) }
        } catch (error) {
            if (request === generation) aiError.value = error
        } finally {
            if (request === generation) aiBusy.value = null
        }
    }
    const discardProposal = (): void => {
        generation += 1
        aiRequest?.abort()
        proposal.value = null
        proposalSnapshot = null
        aiBusy.value = null
        aiStale.value = false
        aiError.value = null
    }
    const applyProposal = (
        selection: { fields?: readonly Extract<keyof Data, string>[]; slug?: boolean } = {},
    ): boolean => {
        if (!proposal.value || aiStale.value || proposalSnapshot !== inputSnapshot()) {
            aiStale.value = true
            return false
        }
        const selected = proposal.value
        if (selected.issues.length) return false
        discardProposal()
        for (const [name, value] of Object.entries(selected.data))
            if (!selection.fields || selection.fields.includes(name as Extract<keyof Data, string>))
                form.setFieldValue(name as never, value as never)
        if (selection.slug !== false && selected.slug !== undefined) slug.value = selected.slug
        remember()
        return true
    }
    if (initial) validateEntry(initial)
    if (drafts[identity.value]) restore(drafts[identity.value]!)
    if (hasSlugInput)
        watch(
            () => toValue(options.slug),
            (value) => {
                slug.value = value ?? ''
            },
            { flush: 'sync' },
        )
    watch(
        [values, slug, metadata],
        () => {
            if (proposal.value && proposalSnapshot !== inputSnapshot()) aiStale.value = true
            remember()
        },
        { deep: true, flush: 'sync' },
    )
    watch(
        sourceIdentity,
        (next, previous) => {
            void switchIdentity(next, previous)
        },
        { flush: 'sync' },
    )
    if (getCurrentScope())
        onScopeDispose(() => {
            remember()
            valueSubscription.unsubscribe()
            loadRequest?.abort()
            aiRequest?.abort()
            generation += 1
        })
    const ready = options.id !== undefined && !initial ? refresh() : Promise.resolve()
    const upload = async (file: File): Promise<AssetRecord & SiteAdminAsset> => {
        uploadProgress.value = 0
        uploadError.value = null
        try {
            let asset: AssetRecord
            if (!options.fetch && typeof XMLHttpRequest !== 'undefined') {
                asset = await uploadWithProgress(`${base}/assets`, file, uploadProgress)
            } else {
                asset = await client.uploadAsset(file)
            }
            uploadProgress.value = 1
            return { ...asset, ...siteAdminAsset(asset, assetUrl) }
        } catch (error) {
            uploadError.value = error instanceof Error ? error.message : 'Upload failed.'
            throw error
        }
    }
    const setAsset = (field: string, asset: AssetRecord | string | null): void => {
        const writable = form as typeof form & { setFieldValue: (name: string, value: unknown) => void }
        writable.setFieldValue(
            field,
            options.presentation && asset
                ? siteAdminAsset(asset, assetUrl)
                : typeof asset === 'object' && asset
                  ? asset.id
                  : asset,
        )
    }
    const publish = (at?: string): Promise<SiteAdminEntryMutation<Data> | undefined> => {
        if (publishing) return publishing
        if (form.state.isSubmitting) {
            serverError.value = { code: 'SITE_ADMIN_CONFLICT', message: 'Wait for the current save before publishing.' }
            return Promise.resolve(undefined)
        }
        submitIntent = at === undefined ? 'publish' : 'schedule'
        scheduleAt = at
        publishedResult = undefined
        publishBusy.value = true
        publishing = (async () => {
            try {
                await form.handleSubmit()
                return publishedResult
            } finally {
                submitIntent = 'save'
                publishBusy.value = false
                publishing = undefined
            }
        })()
        return publishing
    }
    return {
        asset: {
            clear: (field: string) => setAsset(field, null),
            error: uploadError,
            progress: uploadProgress,
            set: setAsset,
            upload,
        },
        conflict,
        publish: () => publish(),
        schedule: (at: string) => publish(at),
        publishBusy,
        callbackError,
        descriptor,
        dirty,
        drafts,
        identity,
        loading,
        loadError,
        refresh,
        ready,
        draft: {
            discard: async () => {
                delete drafts[identity.value]
                form.reset(present(baseline.value))
                slug.value = baseSlug
                discardProposal()
                await refresh()
            },
            serialize: () =>
                clone({ data: serialize(form.state.values) as RawData, slug: slug.value, baseVersion: version.value }),
        },
        metadata: {
            modes: metadata,
            slug,
            setMode: (field: 'slug' | 'excerpt', mode: 'auto' | 'manual') => {
                metadata.value[field] = mode
            },
        },
        ai: {
            proposal,
            busy: aiBusy,
            error: aiError,
            stale: aiStale,
            apply: applyProposal,
            discard: discardProposal,
            run: (action: Action, input: Record<string, unknown> = {}) => propose(action, input),
            /** @deprecated Use application-owned config.ai.models actions with ai.run. */
            generateMetadata: () =>
                propose('metadata', {
                    generate: { slug: metadata.value.slug === 'auto', excerpt: metadata.value.excerpt === 'auto' },
                }),
            proofread: (fields?: readonly Extract<keyof Data, string>[]) =>
                propose('proofread', { ...(fields ? { fields } : {}) }),
        },
        entryId,
        form,
        relation: {
            search: async (model: string, query = '', locale?: string, limit = 20): Promise<EntryRecord[]> => {
                return (await client.listEntries(model, { q: query, limit, ...(locale ? { locale } : {}) })).items
            },
        },
        serverError,
        upload,
        version,
        baseVersion: version,
    }
}
