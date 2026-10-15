import type { ModelDefinition, SiteAdminConfig } from './config'
import type { AnyField, FieldRecord } from './fields'
import { resolveSiteAdminAssets } from './assets-config'
import { resolvePresentation, type PresentationContext, type ModelMeta } from './presentation'

export interface FieldDescriptor {
    i18n?: boolean
    accept?: readonly string[]
    default?: unknown
    description?: string
    fields?: Record<string, FieldDescriptor>
    item?: FieldDescriptor
    integer?: boolean
    kind: AnyField['kind']
    label?: string
    max?: number
    maxItems?: number
    maxLength?: number
    min?: number
    minItems?: number
    minLength?: number
    model?: string
    pattern?: string
    required: boolean
    serverValidation: boolean
    values?: readonly string[]
}

export interface ModelDescriptor {
    meta?: ModelMeta
    fields: Record<string, FieldDescriptor>
    displayFields?: ModelDefinition['displayFields']
    public: boolean
    publishing: boolean
    scheduling: boolean
    revisions: boolean
    route: ModelDefinition['route']
    serverValidation: boolean
    sortable: boolean
}

export interface SiteAdminDescriptor {
    i18n?: { defaultLocale: string; locales: string[] }
    assets: false | { maxUploadSize?: number; separateDrafts: boolean; storage: string }
    models: Record<string, ModelDescriptor>
}

const describeField = (field: AnyField, context?: PresentationContext): FieldDescriptor => {
    const descriptor: FieldDescriptor = {
        ...(field.i18n ? { i18n: true } : {}),
        kind: field.kind,
        required: field.required ?? false,
        serverValidation: field.validate !== undefined,
    }
    if (field.label !== undefined && (context || typeof field.label === 'string'))
        descriptor.label = context ? resolvePresentation(field.label, context) : (field.label as string)
    if (field.description !== undefined && (context || typeof field.description === 'string'))
        descriptor.description = context
            ? resolvePresentation(field.description, context)
            : (field.description as string)
    if (field.default !== undefined) descriptor.default = structuredClone(field.default)
    if ('minLength' in field && field.minLength !== undefined) descriptor.minLength = field.minLength
    if ('maxLength' in field && field.maxLength !== undefined) descriptor.maxLength = field.maxLength
    if ('pattern' in field && field.pattern !== undefined) descriptor.pattern = field.pattern
    if (field.kind === 'number' && field.integer !== undefined) descriptor.integer = field.integer
    if ('min' in field && field.min !== undefined) descriptor.min = field.min
    if ('max' in field && field.max !== undefined) descriptor.max = field.max
    if ('minItems' in field && field.minItems !== undefined) descriptor.minItems = field.minItems
    if ('maxItems' in field && field.maxItems !== undefined) descriptor.maxItems = field.maxItems
    if ('accept' in field && field.accept !== undefined) descriptor.accept = field.accept
    if (field.kind === 'select') descriptor.values = field.values
    if (field.kind === 'relation') descriptor.model = field.model
    if (field.kind === 'object') descriptor.fields = describeFields(field.fields, context)
    if (field.kind === 'array') descriptor.item = describeField(field.item, context)
    return descriptor
}

const describeFields = (fields: FieldRecord, context?: PresentationContext): Record<string, FieldDescriptor> =>
    Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, describeField(field, context)]))

export const createSiteAdminDescriptor = (
    config: SiteAdminConfig,
    context?: PresentationContext,
): SiteAdminDescriptor => ({
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
                fields: describeFields(definition.fields, context),
                meta: (() => {
                    const meta =
                        definition.meta && (context || typeof definition.meta !== 'function')
                            ? context
                                ? resolvePresentation(definition.meta, context)
                                : (definition.meta as Partial<ModelMeta>)
                            : {}
                    return { ...meta, label: meta.label ?? name, plural: meta.plural ?? meta.label ?? name }
                })(),
                ...(definition.displayFields ? { displayFields: definition.displayFields } : {}),
                public: definition.public ?? true,
                publishing: definition.publishing ?? true,
                scheduling: definition.scheduling ?? definition.publishing !== false,
                revisions: definition.revisions ?? true,
                route: definition.route ?? false,
                serverValidation: definition.validate !== undefined,
                sortable: definition.sortable ?? false,
            },
        ]),
    ),
})
