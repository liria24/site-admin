import type { StandardSchemaV1 } from '@standard-schema/spec'
import { markdownAssetReferences } from './markdown/assets'

import type { ModelDefinition } from './config'
import type { AnyField, AssetInput, FieldRecord } from './fields'
import type { SiteAdminIssue } from './errors'

export interface IndexedReference {
    id: string
    path: string
    position: number
}

/** Read projection only: retired fields remain in stored revisions; new writes stay strict. */
export const projectStoredFields = (fields: FieldRecord, data: Record<string, unknown>): Record<string, unknown> => {
    const project = (field: AnyField, value: unknown): unknown => {
        if (field.kind === 'object' && isRecord(value)) return projectStoredFields(field.fields, value)
        if (field.kind === 'array' && Array.isArray(value)) return value.map((item) => project(field.item, item))
        return value
    }
    return Object.fromEntries(
        Object.entries(fields)
            .filter(([key]) => Object.hasOwn(data, key))
            .map(([key, field]) => [key, project(field, data[key])]),
    )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const issue = (path: string, message: string): SiteAdminIssue => ({ path, message })

const pathFromStandardIssue = (value: StandardSchemaV1.Issue, parent: string): string => {
    const suffix = value.path
        ?.map((part) => (typeof part === 'object' && part !== null && 'key' in part ? part.key : part))
        .map(String)
        .join('.')
    return suffix ? [parent, suffix].filter(Boolean).join('.') : parent
}

const runSchema = async (
    schema: StandardSchemaV1<unknown, unknown> | undefined,
    value: unknown,
    path: string,
): Promise<{ issues: SiteAdminIssue[]; value: unknown }> => {
    if (!schema) return { issues: [], value }
    try {
        const result = await schema['~standard'].validate(value)
        return 'issues' in result && result.issues
            ? {
                  issues: result.issues.map((entry) => issue(pathFromStandardIssue(entry, path), entry.message)),
                  value,
              }
            : { issues: [], value: result.value }
    } catch (error) {
        return { issues: [issue(path, error instanceof Error ? error.message : 'Validation failed.')], value }
    }
}

const validateString = (field: AnyField, value: string, path: string): SiteAdminIssue[] => {
    const issues: SiteAdminIssue[] = []
    if ('minLength' in field && field.minLength !== undefined && value.length < field.minLength) {
        issues.push(issue(path, `Must contain at least ${field.minLength} characters.`))
    }
    if ('maxLength' in field && field.maxLength !== undefined && value.length > field.maxLength) {
        issues.push(issue(path, `Must contain at most ${field.maxLength} characters.`))
    }
    if ('pattern' in field && field.pattern !== undefined) {
        try {
            if (!new RegExp(field.pattern, 'u').test(value)) issues.push(issue(path, 'Has an invalid format.'))
        } catch {
            issues.push(issue(path, 'The configured pattern is invalid.'))
        }
    }
    return issues
}

export const validateAsset = (value: unknown, path: string): SiteAdminIssue[] => {
    if (typeof value === 'string' && value.length > 0) return []
    if (isRecord(value) && typeof value.id === 'string' && value.id.length > 0) return []
    return [issue(path, 'Must be an Asset ID or Asset reference.')]
}

const validateField = async (
    field: AnyField,
    value: unknown,
    path: string,
    schemas = true,
): Promise<{ issues: SiteAdminIssue[]; value: unknown }> => {
    if (value === undefined || value === null) {
        return { issues: field.required ? [issue(path, 'Required.')] : [], value }
    }

    let issues: SiteAdminIssue[] = []
    let output: unknown = value
    switch (field.kind) {
        case 'text':
        case 'textarea':
        case 'markdown':
            issues = typeof value === 'string' ? validateString(field, value, path) : [issue(path, 'Must be a string.')]
            break
        case 'url':
            if (typeof value !== 'string') {
                issues.push(issue(path, 'Must be a URL string.'))
            } else {
                issues.push(...validateString(field, value, path))
                try {
                    const parsed = new URL(value)
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
                } catch {
                    issues.push(issue(path, 'Must be an absolute HTTP(S) URL.'))
                }
            }
            break
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                issues.push(issue(path, 'Must be a finite number.'))
            } else {
                if (field.integer && !Number.isInteger(value)) issues.push(issue(path, 'Must be an integer.'))
                if (field.min !== undefined && value < field.min)
                    issues.push(issue(path, `Must be at least ${field.min}.`))
                if (field.max !== undefined && value > field.max)
                    issues.push(issue(path, `Must be at most ${field.max}.`))
            }
            break
        case 'boolean':
            if (typeof value !== 'boolean') issues.push(issue(path, 'Must be a boolean.'))
            break
        case 'datetime':
            if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
                issues.push(issue(path, 'Must be an ISO-compatible date-time string.'))
            }
            break
        case 'select':
            if (typeof value !== 'string' || !field.values.includes(value)) {
                issues.push(issue(path, `Must be one of: ${field.values.join(', ')}.`))
            }
            break
        case 'relation':
            if (typeof value !== 'string' || value.length === 0) issues.push(issue(path, 'Must be an Entry ID.'))
            break
        case 'file':
        case 'image':
            issues.push(...validateAsset(value, path))
            break
        case 'images':
            if (!Array.isArray(value)) {
                issues.push(issue(path, 'Must be an array of Asset references.'))
            } else {
                if (field.minItems !== undefined && value.length < field.minItems) {
                    issues.push(issue(path, `Must contain at least ${field.minItems} items.`))
                }
                if (field.maxItems !== undefined && value.length > field.maxItems) {
                    issues.push(issue(path, `Must contain at most ${field.maxItems} items.`))
                }
                for (const [index, item] of value.entries()) issues.push(...validateAsset(item, `${path}.${index}`))
            }
            break
        case 'object':
            if (!isRecord(value)) {
                issues.push(issue(path, 'Must be an object.'))
            } else {
                const nested = await validateFields(field.fields, value, path, schemas)
                issues.push(...nested.issues)
                output = nested.data
            }
            break
        case 'array':
            if (!Array.isArray(value)) {
                issues.push(issue(path, 'Must be an array.'))
            } else {
                if (field.minItems !== undefined && value.length < field.minItems) {
                    issues.push(issue(path, `Must contain at least ${field.minItems} items.`))
                }
                if (field.maxItems !== undefined && value.length > field.maxItems) {
                    issues.push(issue(path, `Must contain at most ${field.maxItems} items.`))
                }
                const items: unknown[] = []
                for (const [index, item] of value.entries()) {
                    const nested = await validateField(field.item, item, `${path}.${index}`, schemas)
                    issues.push(...nested.issues)
                    items.push(nested.value)
                }
                output = items
            }
            break
    }
    if (issues.length === 0 && schemas) {
        const result = await runSchema(field.validate, output, path)
        issues.push(...result.issues)
        output = result.value
    }
    return { issues, value: output }
}

const validateFields = async (
    fields: FieldRecord,
    data: Record<string, unknown>,
    parent = '',
    schemas = true,
): Promise<{ data: Record<string, unknown>; issues: SiteAdminIssue[] }> => {
    const issues: SiteAdminIssue[] = []
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(data)) {
        if (!Object.hasOwn(fields, key)) issues.push(issue([parent, key].filter(Boolean).join('.'), 'Unknown field.'))
    }
    for (const [key, field] of Object.entries(fields)) {
        const path = [parent, key].filter(Boolean).join('.')
        const result = await validateField(field, data[key], path, schemas)
        issues.push(...result.issues)
        if (Object.hasOwn(data, key) || result.value !== undefined) output[key] = result.value
    }
    return { data: output, issues }
}

export const validateModelData = async (
    definition: ModelDefinition,
    value: unknown,
): Promise<{ data?: Record<string, unknown>; issues: SiteAdminIssue[] }> => {
    if (!isRecord(value)) return { issues: [issue('', 'Must be an object.')] }
    const fields = await validateFields(definition.fields, value)
    if (fields.issues.length > 0) return { issues: fields.issues }
    const model = await runSchema(definition.validate, fields.data, '')
    if (model.issues.length > 0) return { issues: model.issues }
    if (!isRecord(model.value)) return { issues: [issue('', 'Model validation must return an object.')] }
    const final = await validateFields(definition.fields, model.value, '', false)
    return final.issues.length > 0 ? { issues: final.issues } : { data: final.data, issues: [] }
}

export const applyFieldDefaults = (fields: FieldRecord, input: Record<string, unknown>): Record<string, unknown> => {
    const output = { ...input }
    for (const [key, field] of Object.entries(fields)) {
        if (output[key] === undefined && field.default !== undefined) output[key] = structuredClone(field.default)
        if (field.kind === 'object' && isRecord(output[key])) {
            output[key] = applyFieldDefaults(field.fields, output[key])
        }
    }
    return output
}

export const assetId = (value: AssetInput): string => (typeof value === 'string' ? value : value.id)

const collectFieldReferences = (
    field: AnyField,
    value: unknown,
    path: string,
    relations: IndexedReference[],
    assets: IndexedReference[],
): void => {
    if (value === undefined || value === null) return
    if (field.kind === 'relation' && typeof value === 'string') {
        relations.push({ id: value, path, position: 0 })
        return
    }
    if ((field.kind === 'file' || field.kind === 'image') && (typeof value === 'string' || isRecord(value))) {
        assets.push({ id: assetId(value as AssetInput), path, position: 0 })
        return
    }
    if (field.kind === 'images' && Array.isArray(value)) {
        for (const [position, item] of value.entries()) {
            if (typeof item === 'string' || isRecord(item))
                assets.push({ id: assetId(item as AssetInput), path, position })
        }
        return
    }
    if (field.kind === 'object' && isRecord(value)) {
        for (const [key, child] of Object.entries(field.fields)) {
            collectFieldReferences(child, value[key], `${path}.${key}`, relations, assets)
        }
        return
    }
    if (field.kind === 'array' && Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            collectFieldReferences(field.item, item, `${path}.${index}`, relations, assets)
        }
        return
    }
    if (field.kind === 'markdown' && typeof value === 'string') {
        for (const reference of markdownAssetReferences(value)) {
            assets.push({ ...reference, path: `${path}.$markdown` })
        }
    }
}

export const collectReferences = (
    fields: FieldRecord,
    data: Record<string, unknown>,
): { assets: IndexedReference[]; relations: IndexedReference[] } => {
    const assets: IndexedReference[] = []
    const relations: IndexedReference[] = []
    for (const [key, field] of Object.entries(fields)) {
        collectFieldReferences(field, data[key], key, relations, assets)
    }
    return { assets, relations }
}

export const fieldAtPath = (fields: FieldRecord, path: string): AnyField | undefined => {
    let field: AnyField | undefined
    let current = fields
    for (const part of path.split('.')) {
        if (part === '$markdown') continue
        if (/^\d+$/u.test(part)) {
            if (field?.kind !== 'array') return undefined
            field = field.item
            if (field.kind === 'object') current = field.fields
            continue
        }
        field = current[part]
        if (!field) return undefined
        if (field.kind === 'object') current = field.fields
    }
    return field
}
