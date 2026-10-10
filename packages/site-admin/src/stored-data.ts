import type { FieldDescriptor } from './descriptor'

type StoredField = Pick<FieldDescriptor, 'kind'> & {
    fields?: Readonly<Record<string, StoredField>>
    item?: StoredField
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

/** Project trusted snapshots only; never sanitize new input or rewrite historical rows. */
export const projectStoredFields = (
    fields: Readonly<Record<string, StoredField>>,
    data: Record<string, unknown>,
): Record<string, unknown> => {
    const project = (field: StoredField, value: unknown): unknown => {
        if (field.kind === 'object' && field.fields && isRecord(value)) return projectStoredFields(field.fields, value)
        if (field.kind === 'array' && field.item && Array.isArray(value))
            return value.map((item) => project(field.item!, item))
        return value
    }
    return Object.fromEntries(
        Object.entries(fields)
            .filter(([key]) => Object.hasOwn(data, key))
            .map(([key, field]) => [key, project(field, data[key])]),
    )
}
