import type { RequestEvent } from 'nuxt/server'
import type { createAdminClient } from './admin-client'
import type {
    SiteAdminNamedAiActions,
    SiteAdminFormModels,
    SiteAdminPublicModels,
    SiteAdminPublicSummaryModels,
    PublicPage,
    PublicListOptions,
    PublicMarkdownListOptions,
} from './client'
import { serializeAdminInput } from './entry-preparation'
import { presentAdminValue, siteAdminAsset } from './management-assets'
import type { SiteAdminEntryMutation, SiteAdminEntry, SiteAdminManagementClient } from './client'
import { SiteAdminError } from './errors'
import { createManagementOperations } from './server/operations'
import { projectMarkdownListSummary } from './markdown/list-summary'
import { useSiteAdminRuntime } from './nuxt/server'
import { withSiteAdminContext } from './runtime/context'

export interface ServerContent {
    get<Name extends Extract<keyof SiteAdminPublicModels, string>>(
        model: Name,
        id: string,
        options?: PublicListOptions,
    ): Promise<SiteAdminPublicModels[Name] | null>
    list<Name extends Extract<keyof SiteAdminPublicModels, string>>(
        model: Name,
        options: PublicMarkdownListOptions & { markdown: 'summary' },
    ): Promise<SiteAdminPublicSummaryModels[Name][]>
    list<Name extends Extract<keyof SiteAdminPublicModels, string>>(
        model: Name,
        options?: PublicMarkdownListOptions & { markdown?: 'full' },
    ): Promise<SiteAdminPublicModels[Name][]>
    page<Name extends Extract<keyof SiteAdminPublicModels, string>>(
        model: Name,
        page: { limit: number; offset: number },
        options: PublicMarkdownListOptions & { markdown: 'summary' },
    ): Promise<PublicPage<SiteAdminPublicSummaryModels[Name]>>
    page<Name extends Extract<keyof SiteAdminPublicModels, string>>(
        model: Name,
        page: { limit: number; offset: number },
        options?: PublicMarkdownListOptions & { markdown?: 'full' },
    ): Promise<PublicPage<SiteAdminPublicModels[Name]>>
    resolve(
        path: string,
        options?: PublicListOptions,
    ): ReturnType<import('./server/site-admin').SiteAdmin['resolvePath']>
}
export type ServerAdmin = ReturnType<typeof createAdminClient<SiteAdminFormModels>> & {
    content: ServerContent
    tasks: {
        publishDue(now?: Date): Promise<import('./server/types').PublishDueResult>
        collectAssets(): Promise<import('./client').SiteAdminAssetGCResult>
        syncAssets(): Promise<import('./server/types').AssetSyncResult>
        rebuildSearch(): Promise<{ indexed: number }>
    }
}

/** Capture the event now; resolve database bindings only when an operation needs them. */
export const useAdmin = (event?: RequestEvent, platformContext?: object): ServerAdmin => {
    const runtime = useSiteAdminRuntime()
    const instance = () => runtime.getSiteAdmin(event, platformContext)
    const raw = createManagementOperations<RequestEvent, SiteAdminFormModels>(
        instance,
        event?.req,
        event,
        runtime.managementBase,
    )
    const clients = new Map<string, SiteAdminManagementClient<SiteAdminFormModels>>()
    const forModel = (model: string) => {
        if (!clients.has(model))
            clients.set(
                model,
                createManagementOperations<RequestEvent, SiteAdminFormModels>(
                    instance,
                    event?.req,
                    event,
                    runtime.managementBase,
                    model,
                ),
            )
        return clients.get(model)!
    }
    type ModelName = Extract<keyof SiteAdminFormModels, string>
    const descriptor = async (model: string) => {
        const definition = (await instance()).descriptor.models[model]
        if (!definition) throw new SiteAdminError('SITE_ADMIN_MODEL_NOT_FOUND', 'Unknown model.')
        return definition
    }
    const encode = async <
        Input extends { data?: Record<string, unknown>; translations?: import('./i18n').TranslationInput },
    >(
        model: string,
        input: Input,
    ) => serializeAdminInput(await descriptor(model), input)
    const present = async <Value extends SiteAdminEntryMutation>(model: string, value: Value): Promise<Value> => {
        if (!('data' in value)) return value
        return presentAdminValue(await descriptor(model), value, raw.assetUrl)
    }
    const publicValue = (document: { data: Record<string, unknown> } | null) => {
        if (!document) return null
        const { _siteAdmin, ...data } = document.data
        return { ...Object(_siteAdmin), data }
    }
    const task = async (kind: 'publishDue' | 'collectAssets' | 'syncAssets' | 'rebuildSearch', now?: Date) => {
        const admin = await instance()
        if (event) {
            const actor = await admin.authorizeRequest(event.req, event)
            if (kind === 'publishDue') admin.assertPermission(actor, 'system', 'publishDue')
            else if (kind === 'rebuildSearch') admin.assertPermission(actor, 'system', 'rebuildSearch')
            else admin.assertPermission(actor, 'asset', 'gc')
        }
        if (kind === 'publishDue') return admin.publishDue(now)
        if (kind === 'collectAssets') return admin.runAssetGC()
        if (kind === 'rebuildSearch') return admin.rebuildSearch()
        return admin.syncAssetCopies()
    }
    const api = {
        models: async () =>
            Object.entries((await raw.models()).models).map(([name, model]) => ({
                name,
                meta: model.meta ?? { label: name, plural: name },
                features: {
                    publishing: model.publishing,
                    scheduling: model.scheduling,
                    revisions: model.revisions,
                    sortable: model.sortable,
                },
            })),
        entries: {
            list: async <Model extends ModelName>(model: Model, options?: import('./client').ManagementListOptions) => {
                const page = await forModel(model).listEntries(model, options)
                const definition = await descriptor(model)
                return {
                    ...page,
                    items: page.items.map((entry) => presentAdminValue(definition, entry, raw.assetUrl)),
                }
            },
            get: async <Model extends ModelName>(model: Model, id: string) =>
                present(model, await forModel(model).getEntry<SiteAdminFormModels[Model]>(id)),
            create: async <Model extends ModelName>(
                model: Model,
                input: import('./client').SiteAdminCreateEntryInput<SiteAdminFormModels[Model]>,
            ) => present(model, await forModel(model).createEntry(model, await encode(model, input))),
            update: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                input: {
                    data?: Partial<SiteAdminFormModels[Model]>
                    translations?: import('./i18n').TranslationInput<SiteAdminFormModels[Model]>
                },
            ) =>
                present(
                    model,
                    await forModel(model).updateEntry<SiteAdminFormModels[Model]>(selected.id, {
                        ...(await encode(model, input)),
                        expectedVersion: selected.version,
                    }),
                ),
            publish: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                input?: {
                    data?: Partial<SiteAdminFormModels[Model]>
                    translations?: import('./i18n').TranslationInput<SiteAdminFormModels[Model]>
                },
            ) =>
                present(
                    model,
                    await forModel(model).publishEntry<SiteAdminFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                        ...(input && Object.keys(input).length ? { draft: await encode(model, input) } : {}),
                    }),
                ),
            schedule: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                input: {
                    data?: Partial<SiteAdminFormModels[Model]>
                    translations?: import('./i18n').TranslationInput<SiteAdminFormModels[Model]>
                    at: Date | string
                },
            ) => {
                const at = new Date(input.at)
                if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
                    throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Choose a future publication time.')
                const { at: _at, ...candidate } = input
                return present(
                    model,
                    await forModel(model).schedulePublish<SiteAdminFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                        at: at.toISOString(),
                        ...(Object.keys(candidate).length ? { draft: await encode(model, candidate) } : {}),
                    }),
                )
            },
            remove: <Model extends ModelName>(model: Model, selected: { id: string; version: number }) =>
                forModel(model).deleteEntry(selected.id, { expectedVersion: selected.version }),
            unpublish: async <Model extends ModelName>(model: Model, selected: { id: string; version: number }) =>
                present(
                    model,
                    await forModel(model).unpublishEntry<SiteAdminFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                    }),
                ),
            cancelSchedule: async <Model extends ModelName>(model: Model, selected: { id: string; version: number }) =>
                present(
                    model,
                    await forModel(model).cancelScheduledPublish<SiteAdminFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                    }),
                ),
            reorder: <Model extends ModelName>(model: Model, entries: SiteAdminEntry<SiteAdminFormModels[Model]>[]) =>
                forModel(model).setSortOrders(
                    model,
                    entries.map((entry, sortOrder) => ({ id: entry.id, expectedVersion: entry.version, sortOrder })),
                ),
            references: <Model extends ModelName>(
                model: Model,
                id: string,
                options: import('./client').SiteAdminReferencesOptions,
            ) => forModel(model).referencesTo(id, options),
        },
        revisions: {
            list: async <Model extends ModelName>(model: Model, id: string) => {
                const revisions = await forModel(model).listRevisions<SiteAdminFormModels[Model]>(id)
                const definition = await descriptor(model)
                return revisions.map((revision) => presentAdminValue(definition, revision, raw.assetUrl))
            },
            restore: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                revisionId: string,
            ) =>
                present(
                    model,
                    await forModel(model).restoreRevision<SiteAdminFormModels[Model]>(selected.id, revisionId, {
                        expectedVersion: selected.version,
                    }),
                ),
        },
        assets: {
            upload: async (file: File) => siteAdminAsset(await raw.uploadAsset(file), raw.assetUrl),
            get: async (id: string) => siteAdminAsset(await raw.getAsset(id), raw.assetUrl),
            download: (id: string) => raw.downloadAsset(id),
            remove: (id: string) => raw.deleteAsset(id),
        },
        ai: {
            run: async <Name extends Extract<keyof SiteAdminNamedAiActions, string>>(
                name: Name,
                input: SiteAdminNamedAiActions[Name]['input'],
            ): Promise<SiteAdminNamedAiActions[Name]['data']> => {
                if (!event) throw new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'AI actions require a request event.')
                if (!runtime.runAiAction)
                    throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'AI actions are unavailable.')
                return (await runtime.runAiAction(event, name, { input })) as SiteAdminNamedAiActions[Name]['data']
            },
        },
        content: {
            get: async <Name extends Extract<keyof SiteAdminPublicModels, string>>(
                model: Name,
                id: string,
                options: { locale?: string } = {},
            ) =>
                publicValue(await (await instance()).contentDocument(model, id, options?.locale)) as
                    | SiteAdminPublicModels[Name]
                    | null,
            list: async <Name extends Extract<keyof SiteAdminPublicModels, string>>(
                model: Name,
                options?: PublicMarkdownListOptions,
            ) => {
                const admin = await instance()
                const documents = await admin.contentList(model, options?.locale)
                const items =
                    options?.markdown === 'summary'
                        ? await projectMarkdownListSummary(
                              documents,
                              model,
                              admin.config,
                              (id) => runtime.publicBase + '/_assets/' + encodeURIComponent(id),
                          )
                        : documents
                return items.map(publicValue) as SiteAdminPublicModels[Name][]
            },
            page: async <Name extends Extract<keyof SiteAdminPublicModels, string>>(
                model: Name,
                page: { limit: number; offset: number },
                options?: PublicMarkdownListOptions,
            ) => {
                const admin = await instance()
                const result = await admin.contentPage(model, page, options?.locale)
                const documents =
                    options?.markdown === 'summary'
                        ? await projectMarkdownListSummary(
                              result.items,
                              model,
                              admin.config,
                              (id) => runtime.publicBase + '/_assets/' + encodeURIComponent(id),
                          )
                        : result.items
                return { ...result, items: documents.map(publicValue) as SiteAdminPublicModels[Name][] }
            },
            resolve: async (path: string, options: { locale?: string } = {}) =>
                (await instance()).resolvePath(path, options?.locale),
        } as ServerContent,
        tasks: {
            publishDue: async (now?: Date) =>
                (await task('publishDue', now)) as import('./server/types').PublishDueResult,
            collectAssets: async () => (await task('collectAssets')) as import('./client').SiteAdminAssetGCResult,
            syncAssets: async () => (await task('syncAssets')) as import('./server/types').AssetSyncResult,
            rebuildSearch: async () => (await task('rebuildSearch')) as { indexed: number },
        },
    }
    for (const [namespace, group] of Object.entries(api)) {
        if (typeof group === 'function') {
            Object.assign(api, { [namespace]: () => withSiteAdminContext(platformContext ?? event?.context, group) })
            continue
        }
        for (const [name, method] of Object.entries(group)) {
            Object.assign(group, {
                [name]: (...args: unknown[]) =>
                    withSiteAdminContext(platformContext ?? event?.context, () => Reflect.apply(method, group, args)),
            })
        }
    }
    return api
}
