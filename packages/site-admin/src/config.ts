import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ParserOptions } from 'comark'

import type {
    AnyField,
    ArrayField,
    FieldRecord,
    InferField,
    InferFields,
    ObjectField,
    PublicAsset,
    RelationField,
} from './fields'
import type { PublicEntry } from './server/types'

export interface ModelRouteOptions {
    /** Concrete paths are produced by replacing `:slug`. Defaults to `/<model>/:slug`. */
    path?: string
    /** Redirect to the URL stored in this field instead of serving a page. */
    redirect?: string
    /** Exclude this route from llms.txt while keeping it publicly routable. */
    llms?: boolean
    /** Exclude this route from the sitemap while keeping it publicly routable. */
    sitemap?: boolean
    status?: 301 | 302 | 307 | 308
}

export interface ModelDisplayFields {
    description?: string
    image?: string
    title?: string
}

export interface ModelOptions<Fields extends FieldRecord = FieldRecord> {
    fields: Fields
    /** Store one revision stream per locale. Nuxt i18n remains the locale source of truth. */
    localized?: boolean
    displayFields?: ModelDisplayFields
    /** `false` publishes each revision immediately while still retaining history. */
    publishing?: boolean
    /** Public projection is independent from whether the model owns routes. */
    public?: boolean
    route?: boolean | ModelRouteOptions | string
    sortable?: boolean
    validate?: StandardSchemaV1<unknown, InferFields<Fields>>
}

export type ModelDefinition<Fields extends FieldRecord = FieldRecord> = ModelOptions<Fields>

export interface SiteAdminLifecycleEvent {
    actorId?: string
    entryId: string
    model: string
    revisionId?: string
    type: 'create' | 'delete' | 'publish' | 'restore' | 'schedule' | 'unpublish' | 'update'
}

export interface SiteAdminAIConfig {
    slug?: (input: { data: Record<string, unknown>; model: string }) => Promise<string | null> | string | null
}

export type SiteAdminModelAction =
    | 'ai'
    | 'create'
    | 'delete'
    | 'publish'
    | 'prune'
    | 'readDraft'
    | 'restore'
    | 'schedule'
    | 'sort'
    | 'update'

export type SiteAdminAssetAction = 'delete' | 'gc' | 'read' | 'upload'
export type SiteAdminSystemAction = 'diagnostics' | 'publishDue'

export interface SiteAdminRoleDefinition {
    assets?: readonly SiteAdminAssetAction[]
    models?: Readonly<Record<string, readonly SiteAdminModelAction[]>>
    system?: readonly SiteAdminSystemAction[]
}

export interface SiteAdminAuthorization {
    roles: Readonly<Record<string, SiteAdminRoleDefinition>>
}

export const defineSiteAdminAuthorization = <const Roles extends Readonly<Record<string, SiteAdminRoleDefinition>>>(
    roles: Roles,
): SiteAdminAuthorization & { roles: Roles } => {
    if (Object.hasOwn(roles, 'admin')) throw new Error('The built-in "admin" role cannot be overridden.')
    return { roles }
}

export interface SiteAdminConfig<Models extends Record<string, ModelDefinition> = Record<string, ModelDefinition>> {
    ai?: SiteAdminAIConfig
    assets?: {
        maxUploadSize?: number
        operationLeaseSeconds?: number
        cleanup?: { minimumAge?: number }
        /** Keep originals in the private Files SDK `draft` storage. */
        separateDrafts?: boolean
        storage: string
    }
    authorization?: SiteAdminAuthorization
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

type PublicField<F extends AnyField, Models extends Record<string, ModelDefinition>> = F['kind'] extends
    | 'file'
    | 'image'
    ? PublicAsset
    : F['kind'] extends 'images'
      ? PublicAsset[]
      : F extends RelationField<infer Name>
        ? Name extends keyof Models
            ? PublicEntry<Partial<InferPublicModelData<Models[Name], Models>>> | null
            : PublicEntry | null
        : F extends ObjectField<infer Fields>
          ? PublicFields<Fields, Models>
          : F extends ArrayField<infer Item>
            ? Array<PublicField<Item, Models> | (Item extends { required: true } ? never : null)>
            : InferField<F>

type PublicFields<Fields extends FieldRecord, Models extends Record<string, ModelDefinition>> = {
    [Key in keyof InferFields<Fields>]: Key extends keyof Fields
        ? PublicField<Fields[Key], Models> | (null extends InferFields<Fields>[Key] ? null : never)
        : never
}

export type InferPublicModelData<
    Model extends ModelDefinition,
    Models extends Record<string, ModelDefinition> = Record<string, ModelDefinition>,
> = PublicFields<Model['fields'], Models>

export type InferSiteAdminPublicModels<Config extends SiteAdminConfig> = {
    [Name in keyof Config['models']]: PublicEntry<InferPublicModelData<Config['models'][Name], Config['models']>>
}
