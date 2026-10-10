import type { FieldDescriptor } from './descriptor'
import type { SiteAdminIssue } from './errors'

type BuiltinField = Pick<FieldDescriptor, 'kind'> &
    Partial<
        Pick<
            FieldDescriptor,
            | 'required'
            | 'minLength'
            | 'maxLength'
            | 'pattern'
            | 'integer'
            | 'min'
            | 'max'
            | 'minItems'
            | 'maxItems'
            | 'values'
        >
    >

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const issue = (path: string, message: string): SiteAdminIssue => ({ path, message })

export const validateAsset = (value: unknown, path: string): SiteAdminIssue[] => {
    if (typeof value === 'string' && value.length > 0) return []
    if (isRecord(value) && typeof value.id === 'string' && value.id.length > 0) return []
    return [issue(path, 'Must be an Asset ID or Asset reference.')]
}

/** Pure scalar/container rules shared by server fields and serialized form descriptors. */
export const validateBuiltinValue = (field: BuiltinField, value: unknown, path: string): SiteAdminIssue[] => {
    if (value === undefined || value === null) return field.required ? [issue(path, 'Required.')] : []
    const issues: SiteAdminIssue[] = []
    const add = (message: string) => {
        issues.push(issue(path, message))
    }
    switch (field.kind) {
        case 'text':
        case 'textarea':
        case 'markdown':
        case 'url':
            if (typeof value !== 'string') {
                add(field.kind === 'url' ? 'Must be a URL string.' : 'Must be a string.')
                break
            }
            if (field.minLength !== undefined && value.length < field.minLength)
                add(`Must contain at least ${field.minLength} characters.`)
            if (field.maxLength !== undefined && value.length > field.maxLength)
                add(`Must contain at most ${field.maxLength} characters.`)
            if (field.pattern !== undefined) {
                try {
                    if (!new RegExp(field.pattern, 'u').test(value)) add('Has an invalid format.')
                } catch {
                    add('The configured pattern is invalid.')
                }
            }
            if (field.kind === 'url') {
                try {
                    const parsed = new URL(value)
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
                } catch {
                    add('Must be an absolute HTTP(S) URL.')
                }
            }
            break
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) add('Must be a finite number.')
            else {
                if (field.integer && !Number.isInteger(value)) add('Must be an integer.')
                if (field.min !== undefined && value < field.min) add(`Must be at least ${field.min}.`)
                if (field.max !== undefined && value > field.max) add(`Must be at most ${field.max}.`)
            }
            break
        case 'boolean':
            if (typeof value !== 'boolean') add('Must be a boolean.')
            break
        case 'datetime':
            if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
                add('Must be an ISO-compatible date-time string.')
            break
        case 'select':
            if (typeof value !== 'string' || !field.values?.includes(value))
                add(`Must be one of: ${(field.values ?? []).join(', ')}.`)
            break
        case 'relation':
            if (typeof value !== 'string' || value.length === 0) add('Must be an Entry ID.')
            break
        case 'file':
        case 'image':
            issues.push(...validateAsset(value, path))
            break
        case 'object':
            if (!isRecord(value)) add('Must be an object.')
            break
        case 'images':
        case 'array':
            if (!Array.isArray(value))
                add(field.kind === 'images' ? 'Must be an array of Asset references.' : 'Must be an array.')
            else {
                if (field.minItems !== undefined && value.length < field.minItems)
                    add(`Must contain at least ${field.minItems} items.`)
                if (field.maxItems !== undefined && value.length > field.maxItems)
                    add(`Must contain at most ${field.maxItems} items.`)
                if (field.kind === 'images')
                    for (const [index, item] of value.entries()) issues.push(...validateAsset(item, `${path}.${index}`))
            }
            break
    }
    return issues
}
