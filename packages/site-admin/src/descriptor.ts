import type { ModelDefinition, SiteAdminConfig } from './config'
import type { AnyField, FieldRecord } from './fields'
import { resolveSiteAdminAssets } from './assets-config'

export interface FieldDescriptor {
    accept?: readonly string[]
    default?: unknown
    description?: string
    fields?: Record<string, FieldDescriptor>
    item?: FieldDescriptor
    kind: AnyField['kind']
    label?: string
    max?: number
    maxItems?: number
    maxLength?: number
    min?: number
    minItems?: number
    minLength?: number
    model?: string
    required: boolean
    serverValidation: boolean
    values?: readonly string[]
}

export interface ModelDescriptor {
    fields: Record<string, FieldDescriptor>
    displayFields?: ModelDefinition['displayFields']
    public: boolean
    publishing: boolean
    route: ModelDefinition['route']
    serverValidation: boolean
    sortable: boolean
}

export interface SiteAdminDescriptor {
    assets: false | { maxUploadSize?: number; separateDrafts: boolean; storage: string }
    models: Record<string, ModelDescriptor>
}

const describeField = (field: AnyField): FieldDescriptor => {
    const descriptor: FieldDescriptor = {
        kind: field.kind,
        required: field.required ?? false,
        serverValidation: field.validate !== undefined,
    }
    if (field.label !== undefined) descriptor.label = field.label
    if (field.description !== undefined) descriptor.description = field.description
    if (field.default !== undefined) descriptor.default = structuredClone(field.default)
    if ('minLength' in field && field.minLength !== undefined) descriptor.minLength = field.minLength
    if ('maxLength' in field && field.maxLength !== undefined) descriptor.maxLength = field.maxLength
    if ('min' in field && field.min !== undefined) descriptor.min = field.min
    if ('max' in field && field.max !== undefined) descriptor.max = field.max
    if ('minItems' in field && field.minItems !== undefined) descriptor.minItems = field.minItems
    if ('maxItems' in field && field.maxItems !== undefined) descriptor.maxItems = field.maxItems
    if ('accept' in field && field.accept !== undefined) descriptor.accept = field.accept
    if (field.kind === 'select') descriptor.values = field.values
    if (field.kind === 'relation') descriptor.model = field.model
    if (field.kind === 'object') descriptor.fields = describeFields(field.fields)
    if (field.kind === 'array') descriptor.item = describeField(field.item)
    return descriptor
}

const describeFields = (fields: FieldRecord): Record<string, FieldDescriptor> =>
    Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, describeField(field)]))

export const createSiteAdminDescriptor = (config: SiteAdminConfig): SiteAdminDescriptor => ({
    assets: config.assets
        ? {
              ...(config.assets.maxUploadSize === undefined ? {} : { maxUploadSize: config.assets.maxUploadSize }),
              storage: config.assets.storage ?? resolveSiteAdminAssets(config.assets, config)!.storage!,
              separateDrafts: config.assets.separateDrafts === true,
          }
        : false,
    models: Object.fromEntries(
        Object.entries(config.models).map(([name, definition]) => [
            name,
            {
                fields: describeFields(definition.fields),
                ...(definition.displayFields ? { displayFields: definition.displayFields } : {}),
                public: definition.public ?? true,
                publishing: definition.publishing ?? true,
                route: definition.route ?? false,
                serverValidation: definition.validate !== undefined,
                sortable: definition.sortable ?? false,
            },
        ]),
    ),
})
