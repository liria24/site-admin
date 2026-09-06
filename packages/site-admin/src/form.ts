import { useForm } from '@tanstack/vue-form'
import { ref, type Ref } from 'vue'

import type { FieldDescriptor, ModelDescriptor } from './descriptor'
import type { AssetRecord, EntryRecord } from './server/types'
import type { SiteAdminIssue } from './errors'

export interface SiteAdminFormError {
    code: string
    issues?: SiteAdminIssue[]
    message: string
}

export interface UseSiteAdminFormOptions<Data extends Record<string, unknown>> {
    action: string
    defaultValues?: Partial<Data>
    expectedVersion?: number
    fetch?: typeof globalThis.fetch
    method?: 'PATCH' | 'POST'
    model: ModelDescriptor
    onSuccess?: (entry: EntryRecord) => Promise<void> | void
    slug?: string
}

const fieldDefault = (field: FieldDescriptor): unknown => {
    if (field.default !== undefined) return structuredClone(field.default)
    if (field.kind === 'object') return defaultsFromFields(field.fields ?? {})
    if (field.kind === 'array' || field.kind === 'images') return []
    if (field.kind === 'boolean') return false
    if (field.kind === 'number') return 0
    return ''
}

const defaultsFromFields = (fields: Record<string, FieldDescriptor>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldDefault(field)]))

export const siteAdminFormDefaults = <Data extends Record<string, unknown>>(
    model: ModelDescriptor,
    values: Partial<Data> = {},
): Data => ({ ...defaultsFromFields(model.fields), ...values }) as Data

const readError = async (response: Response): Promise<SiteAdminFormError> => {
    const payload: unknown = await response.json().catch(() => null)
    if (
        typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'object' &&
        payload.error !== null &&
        'code' in payload.error &&
        'message' in payload.error
    ) {
        const error = payload.error as { code: unknown; issues?: unknown; message: unknown }
        return {
            code: String(error.code),
            ...(Array.isArray(error.issues) ? { issues: error.issues as SiteAdminIssue[] } : {}),
            message: String(error.message),
        }
    }
    return { code: 'SITE_ADMIN_REQUEST_FAILED', message: `Request failed with status ${response.status}.` }
}

export const useSiteAdminForm = <Data extends Record<string, unknown>>(
    options: UseSiteAdminFormOptions<Data>,
): {
    conflict: Ref<boolean>
    form: ReturnType<typeof useForm<Data, readonly [], EntryRecord>>
    serverError: Ref<SiteAdminFormError | null>
    upload: (file: File) => Promise<AssetRecord>
} => {
    const request = options.fetch ?? globalThis.fetch
    const serverError = ref<SiteAdminFormError | null>(null)
    const conflict = ref(false)
    const form = useForm({
        defaultValues: siteAdminFormDefaults(options.model, options.defaultValues),
        onSubmit: async ({ value }) => {
            serverError.value = null
            conflict.value = false
            const response = await request(options.action, {
                body: JSON.stringify({
                    data: value,
                    ...(options.expectedVersion === undefined
                        ? {}
                        : { expectedVersion: options.expectedVersion }),
                    ...(options.slug === undefined ? {} : { slug: options.slug }),
                }),
                headers: { 'content-type': 'application/json' },
                method: options.method ?? (options.expectedVersion === undefined ? 'POST' : 'PATCH'),
            })
            if (!response.ok) {
                const error = await readError(response)
                serverError.value = error
                conflict.value = error.code === 'SITE_ADMIN_CONFLICT'
                throw new Error(error.message)
            }
            const entry = (await response.json()) as EntryRecord
            await options.onSuccess?.(entry)
            return entry
        },
    })
    return {
        conflict,
        form,
        serverError,
        upload: async (file) => {
            const data = new FormData()
            data.set('file', file)
            const base = new URL(options.action, globalThis.location?.origin ?? 'http://localhost').pathname
            const managementBase = base.split('/entries/')[0] ?? '/api/site-admin'
            const response = await request(`${managementBase}/assets`, { body: data, method: 'POST' })
            if (!response.ok) throw new Error((await readError(response)).message)
            return (await response.json()) as AssetRecord
        },
    }
}
