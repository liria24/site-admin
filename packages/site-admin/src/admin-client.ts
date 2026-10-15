import { prepareAdminEntry } from './entry-preparation'
import {
    SiteAdminClientError,
    type ManagementListOptions,
    type SiteAdminEntry,
    type SiteAdminManagementClient,
    type SiteAdminManagementModels,
    type SiteAdminNamedAiActions,
    type SiteAdminReferencesOptions,
    type SiteAdminCreateEntryInput,
} from './client'
import type { EntryPrepareContext } from './model'
import { presentAdminValue, siteAdminAsset } from './management-assets'
import type { ModelDescriptor } from './descriptor'
import type { TranslationInput } from './i18n'

type Target = { id: string; version: number }
type Shape<Models> = { [Name in keyof Models]: Record<string, unknown> }
type NameOf<Models> = Extract<keyof Models, string>
type Input<Data> = { data?: Partial<Data>; translations?: TranslationInput<Data>; defaultLocale?: string }

/** Imperative operations have no Vue lifetime or reactive state. */
export const createAdminClient = <Models extends Shape<Models> = SiteAdminManagementModels>(
    client: SiteAdminManagementClient<Models>,
    prepare?: (context: EntryPrepareContext) => void | Promise<void>,
    identity: () => string = () => 'request',
    uiLocale: () => string | undefined = () => undefined,
) => {
    let cached: { scope: string; value: ReturnType<typeof client.models> } | undefined
    const descriptors = () => {
        const scope = identity()
        if (cached?.scope !== scope) {
            const value = client.models({ ...(uiLocale() ? { uiLocale: uiLocale()! } : {}) })
            cached = { scope, value }
            void value.catch(() => {
                if (cached?.value === value) cached = undefined
            })
        }
        return cached.value
    }
    const describe = async (model: string): Promise<ModelDescriptor> => {
        const scope = identity()
        const descriptor = (await descriptors()).models[model]
        if (scope !== identity()) throw new DOMException('Authentication changed.', 'AbortError')
        if (!descriptor) throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', 'Model is unavailable.', 403)
        return descriptor
    }
    const present = <Value extends object>(entry: Value, descriptor: ModelDescriptor) =>
        presentAdminValue(descriptor, entry, client.assetUrl)
    const target = async <Name extends NameOf<Models>>(model: Name, selected: Target) => {
        const scope = identity()
        const [descriptor, entry] = await Promise.all([describe(model), client.getEntry<Models[Name]>(selected.id)])
        if (scope !== identity()) throw new DOMException('Authentication changed.', 'AbortError')
        if (entry.model !== model || entry.version !== selected.version)
            throw new SiteAdminClientError('SITE_ADMIN_CONFLICT', 'Reload the current entry before saving.', 409)
        return { descriptor, entry }
    }
    const candidate = async <Name extends NameOf<Models>>(
        model: Name,
        descriptor: ModelDescriptor,
        operation: EntryPrepareContext['operation'],
        input: Input<Models[Name]>,
        entry?: SiteAdminEntry<Models[Name]>,
    ) => {
        const scope = identity()
        return prepareAdminEntry({
            model,
            descriptor,
            operation,
            input,
            ...(entry ? { entry } : {}),
            defaultLocale:
                entry?.defaultLocale ?? input.defaultLocale ?? (await descriptors()).i18n?.defaultLocale ?? '',
            assetUrl: client.assetUrl,
            signal: new AbortController().signal,
            ...(prepare ? { prepare } : {}),
            guard: () => {
                if (scope !== identity()) throw new DOMException('Authentication changed.', 'AbortError')
            },
            resource: {
                display: (value) => ({
                    title: String(value[descriptor.displayFields?.title ?? 'title'] ?? ''),
                    description: String(value[descriptor.displayFields?.description ?? 'description'] ?? ''),
                    image: undefined,
                }),
            },
        })
    }

    return {
        models: async () =>
            Object.entries((await descriptors()).models).map(([name, model]) => ({
                name,
                meta: (model.meta ?? { label: name, plural: name }) as import('./client').SiteAdminModelMeta,
                features: {
                    publishing: model.publishing,
                    scheduling: model.scheduling,
                    revisions: model.revisions,
                    sortable: model.sortable,
                },
            })),
        entries: {
            list: async <Name extends NameOf<Models>>(model: Name, options?: ManagementListOptions) => {
                const [page, descriptor] = await Promise.all([client.listEntries(model, options), describe(model)])
                return { ...page, items: page.items.map((entry) => present(entry, descriptor)) }
            },
            get: async <Name extends NameOf<Models>>(model: Name, id: string) => {
                const [entry, descriptor] = await Promise.all([client.getEntry<Models[Name]>(id), describe(model)])
                if (entry.model !== model)
                    throw new SiteAdminClientError('SITE_ADMIN_ENTRY_NOT_FOUND', 'Entry not found.', 404)
                return present(entry, descriptor)
            },
            create: async <Name extends NameOf<Models>>(
                model: Name,
                input: SiteAdminCreateEntryInput<Models[Name]>,
            ) => {
                const descriptor = await describe(model)
                return present(
                    await client.createEntry(model, {
                        ...input,
                        ...(await candidate(model, descriptor, 'save', input)),
                    }),
                    descriptor,
                )
            },
            update: async <Name extends NameOf<Models>>(model: Name, selected: Target, input: Input<Models[Name]>) => {
                const { descriptor, entry } = await target(model, selected)
                return present(
                    await client.updateEntry<Models[Name]>(selected.id, {
                        ...(await candidate(model, descriptor, 'save', input, entry)),
                        expectedVersion: selected.version,
                    }),
                    descriptor,
                )
            },
            publish: async <Name extends NameOf<Models>>(
                model: Name,
                selected: Target,
                input: Input<Models[Name]> = {},
            ) => {
                const { descriptor, entry } = await target(model, selected)
                return present(
                    await client.publishEntry<Models[Name]>(selected.id, {
                        expectedVersion: selected.version,
                        draft: await candidate(model, descriptor, 'publish', input, entry),
                    }),
                    descriptor,
                )
            },
            schedule: async <Name extends NameOf<Models>>(
                model: Name,
                selected: Target,
                input: Input<Models[Name]> & { at: Date | string },
            ) => {
                const at = new Date(input.at)
                if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
                    throw new SiteAdminClientError('SITE_ADMIN_INVALID_INPUT', 'Choose a future publication time.', 400)
                const { descriptor, entry } = await target(model, selected)
                return present(
                    await client.schedulePublish<Models[Name]>(selected.id, {
                        expectedVersion: selected.version,
                        at: at.toISOString(),
                        draft: await candidate(model, descriptor, 'schedule', input, entry),
                    }),
                    descriptor,
                )
            },
            remove: async <Name extends NameOf<Models>>(model: Name, selected: Target) => {
                await target(model, selected)
                return client.deleteEntry(selected.id, { expectedVersion: selected.version })
            },
            unpublish: async <Name extends NameOf<Models>>(model: Name, selected: Target) => {
                const { descriptor } = await target(model, selected)
                return present(
                    await client.unpublishEntry<Models[Name]>(selected.id, { expectedVersion: selected.version }),
                    descriptor,
                )
            },
            cancelSchedule: async <Name extends NameOf<Models>>(model: Name, selected: Target) => {
                const { descriptor } = await target(model, selected)
                return present(
                    await client.cancelScheduledPublish<Models[Name]>(selected.id, {
                        expectedVersion: selected.version,
                    }),
                    descriptor,
                )
            },
            reorder: <Name extends NameOf<Models>>(model: Name, entries: SiteAdminEntry<Models[Name]>[]) =>
                client.setSortOrders(
                    model,
                    entries.map((entry, index) => ({ id: entry.id, expectedVersion: entry.version, sortOrder: index })),
                ),
            references: async <Name extends NameOf<Models>>(
                model: Name,
                id: string,
                options: SiteAdminReferencesOptions,
            ) => {
                const entry = await client.getEntry(id)
                if (entry.model !== model)
                    throw new SiteAdminClientError('SITE_ADMIN_ENTRY_NOT_FOUND', 'Entry not found.', 404)
                return client.referencesTo(id, options)
            },
        },
        revisions: {
            list: async <Name extends NameOf<Models>>(model: Name, id: string) => {
                const descriptor = await describe(model)
                return (await client.listRevisions<Models[Name]>(id)).map((revision) => present(revision, descriptor))
            },
            restore: async <Name extends NameOf<Models>>(model: Name, selected: Target, revisionId: string) => {
                const { descriptor } = await target(model, selected)
                return present(
                    await client.restoreRevision<Models[Name]>(selected.id, revisionId, {
                        expectedVersion: selected.version,
                    }),
                    descriptor,
                )
            },
        },
        assets: {
            upload: async (file: File) => siteAdminAsset(await client.uploadAsset(file), client.assetUrl),
            get: async (id: string) => siteAdminAsset(await client.getAsset(id), client.assetUrl),
            download: (id: string) => client.downloadAsset(id),
            remove: (id: string) => client.deleteAsset(id),
        },
        ai: {
            run: <Name extends Extract<keyof SiteAdminNamedAiActions, string>>(
                name: Name,
                input: SiteAdminNamedAiActions[Name]['input'],
                options?: { signal?: AbortSignal },
            ): Promise<SiteAdminNamedAiActions[Name]['data']> => client.runAiAction(name, { input }, options),
        },
    }
}
