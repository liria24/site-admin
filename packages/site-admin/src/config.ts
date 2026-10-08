import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { MarkdownDocument, ParserOptions } from 'comark'
import type { FilesEnvironmentConfig, FilesConfigInput, defineFilesConfig } from 'nuxt-files-sdk/config'
import type { SiteAdminAIAction, SiteAdminWorkersAIConfig } from './ai'
import type { SiteAdminDatabaseConfig } from './runtime/database'
import type { SiteAdminTaskOptions } from './runtime/tasks'

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

export type SiteAdminAIConfig = {
    /** Server-only custom suggestion actions. Provider and model instances stay in this config. */
    models?: Record<string, Record<string, SiteAdminAIAction>>
    slug?: (input: { data: Record<string, unknown>; model: string }) => Promise<string | null> | string | null
} & (SiteAdminWorkersAIConfig | { provider?: never; model?: never; binding?: never })

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

export interface SiteAdminConfig<
    Models extends Record<string, ModelDefinition> = Record<string, ModelDefinition>,
> extends FilesEnvironmentConfig {
    ai?: SiteAdminAIConfig
    assets?: {
        maxUploadSize?: number
        operationLeaseSeconds?: number
        cleanup?: { minimumAge?: number }
        /** Keep originals in the private Files SDK `draft` storage. */
        separateDrafts?: boolean
        /** Required with multiple storages; inferred when exactly one storage is configured. */
        storage?: string
    }
    authorization?: SiteAdminAuthorization
    /** Connection only. Generating and applying migrations remains the application's responsibility. */
    database?: SiteAdminDatabaseConfig
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
    /** Explicit opt-in: true permits manual invocation; a cron string also schedules the task. */
    tasks?: SiteAdminTaskOptions
}

type EnvironmentOverride<Value> = Value extends (...args: never[]) => unknown
    ? Value
    : Value extends readonly unknown[]
      ? Value
      : Value extends object
        ? { [Key in keyof Value]?: EnvironmentOverride<Value[Key]> }
        : Value

export type SiteAdminConfigInput<Models extends Record<string, ModelDefinition> = Record<string, ModelDefinition>> =
    SiteAdminConfig<Models> & {
        $development?: EnvironmentOverride<SiteAdminConfig<Models>>
        $production?: EnvironmentOverride<SiteAdminConfig<Models>>
        $test?: EnvironmentOverride<SiteAdminConfig<Models>>
        $prerender?: EnvironmentOverride<SiteAdminConfig<Models>>
        $env?: Record<string, EnvironmentOverride<SiteAdminConfig<Models>>>
    }

/** Derive validation from the SDK's existing public function instead of copying its native option types. */
type FilesPart<Config> = Pick<Config, Extract<keyof Config, keyof FilesEnvironmentConfig>> & {
    [Key in Extract<keyof Config, Exclude<keyof FilesConfigInput, keyof FilesEnvironmentConfig>>]: Key extends '$env'
        ? { [Environment in keyof Config[Key]]: FilesPart<Config[Key][Environment]> }
        : FilesPart<Config[Key]>
}

type NativeFilesCheck<Config> = Parameters<typeof defineFilesConfig<FilesPart<Config>>>[0]
type ConfigProperty<Value, Key extends PropertyKey> = Key extends keyof Value ? Value[Key] : unknown
// Keep the SDK's root-aware route checks, but don't impose its Files-only $env index
// signature on Site Admin domain properties inside those named environments.
type FilesInputCheck<Config> = Omit<NativeFilesCheck<Config>, '$env'> &
    (Config extends { $env: infer Environments extends object }
        ? {
              $env: {
                  [Name in keyof Environments]: ConfigProperty<
                      NonNullable<ConfigProperty<NativeFilesCheck<Config>, '$env'>>,
                      Name
                  >
              }
          }
        : unknown)

export const defineSiteAdminConfig = <const Config extends SiteAdminConfigInput>(
    config: Config & (Config extends FilesInputCheck<NoInfer<Config>> ? unknown : FilesInputCheck<NoInfer<Config>>),
): Config => config

type MergeEnvironment<Base, Override> = Override extends (...args: never[]) => unknown
    ? Override
    : Override extends readonly unknown[]
      ? Override
      : Override extends object
        ? Base extends object
            ? Omit<Base, keyof Override> & {
                  [Key in keyof Override]: Key extends keyof Base
                      ? MergeEnvironment<Base[Key], Override[Key]>
                      : Override[Key]
              }
            : Override
        : Override

type EnvironmentBranch<Config, Name extends string> =
    ConfigProperty<Config, `$${Name}`> extends infer Branch ? (Branch extends object ? Branch : {}) : {}
type NamedEnvironmentBranch<Config, Name extends string> =
    ConfigProperty<Config, '$env'> extends infer Environments
        ? ConfigProperty<NonNullable<Environments>, Name> extends infer Branch
            ? Branch extends object
                ? Branch
                : {}
            : {}
        : {}
type ResolveEnvironments<Config, Environments extends readonly string[]> = Environments extends readonly [
    infer Name extends string,
    ...infer Rest extends readonly string[],
]
    ? ResolveEnvironments<
          MergeEnvironment<
              MergeEnvironment<Config, EnvironmentBranch<Config, Name>>,
              NamedEnvironmentBranch<Config, Name>
          >,
          Rest
      >
    : { [Key in keyof Config as Key extends `$${string}` ? never : Key]: Config[Key] }

/** Model/client/schema types follow the environment selected by the Nuxt build. */
export type ResolvedSiteAdminConfig<Config extends SiteAdminConfigInput, Environments extends readonly string[]> =
    ResolveEnvironments<Config, Environments> extends infer Resolved extends SiteAdminConfig ? Resolved : never

export type InferModelData<Model extends ModelDefinition> = InferFields<Model['fields']>

export type InferSiteAdminModels<Config extends SiteAdminConfig> = {
    [Name in keyof Config['models']]: InferModelData<Config['models'][Name]>
}

type PublicField<
    F extends AnyField,
    Models extends Record<string, ModelDefinition>,
    ParseMarkdown extends boolean,
> = F['kind'] extends 'file' | 'image'
    ? PublicAsset
    : F['kind'] extends 'images'
      ? PublicAsset[]
      : F['kind'] extends 'markdown'
        ? ParseMarkdown extends true
            ? MarkdownDocument<Record<string, unknown>, Record<string, unknown>>
            : InferField<F>
        : F extends RelationField<infer Name>
          ? Name extends keyof Models
              ? // The content parser treats relation projections as opaque objects.
                PublicEntry<Partial<InferPublicModelData<Models[Name], Models, false>>> | null
              : PublicEntry | null
          : F extends ObjectField<infer Fields>
            ? PublicFields<Fields, Models, ParseMarkdown>
            : F extends ArrayField<infer Item>
              ? Array<PublicField<Item, Models, ParseMarkdown> | (Item extends { required: true } ? never : null)>
              : InferField<F>

type PublicFields<
    Fields extends FieldRecord,
    Models extends Record<string, ModelDefinition>,
    ParseMarkdown extends boolean,
> = {
    [Key in keyof InferFields<Fields>]: Key extends keyof Fields
        ? PublicField<Fields[Key], Models, ParseMarkdown> | (null extends InferFields<Fields>[Key] ? null : never)
        : never
}

/** Public content HTTP responses parse this model's Markdown fields into Comark documents. */
export type InferPublicModelData<
    Model extends ModelDefinition,
    Models extends Record<string, ModelDefinition> = Record<string, ModelDefinition>,
    ParseMarkdown extends boolean = true,
> = PublicFields<Model['fields'], Models, ParseMarkdown>

export type InferSiteAdminPublicModels<Config extends SiteAdminConfig> = {
    [Name in keyof Config['models'] as Config['models'][Name] extends { public: false } ? never : Name]: PublicEntry<
        InferPublicModelData<Config['models'][Name], Config['models']>
    >
}
