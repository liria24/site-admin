import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ParserOptions } from 'comark'

import type { FieldRecord, InferFields } from './fields'

export interface ModelRouteOptions {
    /** Concrete paths are produced by replacing `:slug`. Defaults to `/<model>/:slug`. */
    path?: string
    /** Redirect to the URL stored in this field instead of serving a page. */
    redirect?: string
    status?: 301 | 302 | 307 | 308
}

export interface ModelPresentation {
    description?: string
    image?: string
    title?: string
}

export interface ModelOptions<Fields extends FieldRecord = FieldRecord> {
    fields: Fields
    presentation?: ModelPresentation
    /** `false` publishes each revision immediately while still retaining history. */
    publishing?: boolean
    /** Public projection is independent from whether the model owns routes. */
    public?: boolean
    route?: boolean | ModelRouteOptions
    schemaVersion?: number
    sortable?: boolean
    validate?: StandardSchemaV1<unknown, InferFields<Fields>>
}

export interface ModelDefinition<Fields extends FieldRecord = FieldRecord> extends ModelOptions<Fields> {
    readonly kind: 'model'
}

export const model = <const Fields extends FieldRecord>(
    options: ModelOptions<Fields>,
): ModelDefinition<Fields> => ({ kind: 'model', ...options })

export interface SiteAdminLifecycleEvent {
    actorId?: string
    entryId: string
    model: string
    revisionId?: string
    type: 'create' | 'delete' | 'publish' | 'schedule' | 'unpublish' | 'update'
}

export interface SiteAdminAIConfig {
    slug?: (input: { data: Record<string, unknown>; model: string }) => Promise<string | null> | string | null
}

export interface SiteAdminConfig<
    Models extends Record<string, ModelDefinition> = Record<string, ModelDefinition>,
> {
    ai?: SiteAdminAIConfig
    assets?: {
        maxUploadSize?: number
        orphanGracePeriod?: string
        storage: string
    }
    hooks?: {
        afterCommit?: (event: SiteAdminLifecycleEvent) => Promise<void> | void
    }
    markdown?: {
        plugins?: ParserOptions['plugins']
        summary?: {
            delimiter?: string
            enabled?: boolean
        }
    }
    modelDefaults?: {
        historicalRedirectStatus?: 301 | 302 | 307 | 308
        relationOnDelete?: 'restrict'
        slug?: { maxLength?: number }
    }
    models: Models
}

export const defineSiteAdminConfig = <const Models extends Record<string, ModelDefinition>>(
    config: SiteAdminConfig<Models>,
): SiteAdminConfig<Models> => config

export type InferModelData<Model extends ModelDefinition> = InferFields<Model['fields']>

export type InferSiteAdminModels<Config extends SiteAdminConfig> = {
    [Name in keyof Config['models']]: InferModelData<Config['models'][Name]>
}
