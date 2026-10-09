import type { StandardSchemaV1 } from '@standard-schema/spec'
import { useForm } from '@tanstack/vue-form'
import { ref, toRaw, type Ref } from 'vue'

import { createSiteAdminManagementClient, SiteAdminClientError } from './client'
import type { FieldDescriptor, ModelDescriptor } from './descriptor'
import type { SiteAdminIssue } from './errors'
import type { AssetRecord, EntryRecord, EntryMutationResult } from './server/types'
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
    locale?: string
    managementBase?: string
    modelName: string
    origin?: string
    onSuccess?: (entry: EntryMutationResult) => Promise<void> | void
    slug?: string
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

export const useSiteAdminForm = <Data extends Record<string, unknown>>(options: UseSiteAdminFormOptions<Data>) => {
    const basePath = `/${(options.managementBase ?? '/api/site-admin').split('/').filter(Boolean).join('/')}`
    const base = `${options.origin?.replace(/\/$/u, '') ?? ''}${basePath}`
    const client = createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
        basePath,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
    })
    const entryId = ref(options.entry?.id ?? null)
    const version = ref(options.entry?.version ?? null)
    const serverError = ref<SiteAdminFormError | null>(null)
    const conflict = ref(false)
    const uploadProgress = ref<number | null>(null)
    const uploadError = ref<string | null>(null)
    const form = useForm({
        defaultValues: siteAdminFormDefaults(
            options.descriptor,
            (options.entry?.data as Partial<Data> | undefined) ?? options.defaultValues,
        ),
        validators: [{ run: descriptorSchema<Data>(options.descriptor), triggers: [] }],
        onSubmit: async ({ createValidationError, parseIssues, value }) => {
            serverError.value = null
            conflict.value = false
            const updating = entryId.value !== null
            let entry: EntryMutationResult
            try {
                const input = {
                    data: value,
                    ...(options.slug === undefined ? {} : { slug: options.slug }),
                }
                entry = updating
                    ? await client.updateEntry(entryId.value!, { ...input, expectedVersion: version.value! })
                    : await client.createEntry(options.modelName, {
                          ...input,
                          ...(options.locale ? { locale: options.locale } : {}),
                      })
            } catch (cause) {
                if (!(cause instanceof SiteAdminClientError)) throw cause
                const error: SiteAdminFormError = {
                    code: cause.code,
                    ...(cause.issues ? { issues: cause.issues } : {}),
                    message: cause.message,
                }
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
            entryId.value = entry.id
            version.value = entry.version
            form.reset(('data' in entry ? entry.data : value) as Data)
            await options.onSuccess?.(entry)
            return entry
        },
    })
    const upload = async (file: File): Promise<AssetRecord> => {
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
            return asset
        } catch (error) {
            uploadError.value = error instanceof Error ? error.message : 'Upload failed.'
            throw error
        }
    }
    const setAsset = (field: string, asset: AssetRecord | string | null): void => {
        const writable = form as typeof form & { setFieldValue: (name: string, value: unknown) => void }
        writable.setFieldValue(field, typeof asset === 'object' && asset ? asset.id : asset)
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
    }
}
