import { getCurrentScope, ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import {
    SiteAdminClientError,
    type ManagementListOptions,
    type SiteAdminEntry,
    type SiteAdminManagementClient,
    type SiteAdminManagementModels,
    type SiteAdminNamedAiActions,
    type SiteAdminReferencesOptions,
} from './client'
import { createSiteAdminModel, type EntryPrepareContext } from './model'
import { presentSiteAdminData, siteAdminAsset } from './management-assets'

type Target = { id: string; version: number }
type ModelsShape<Models> = { [Name in keyof Models]: Record<string, unknown> }

/** Nuxt's imperative API uses the same serialization and preparation as resources. */
export const createAdminClient = <Models extends ModelsShape<Models> = SiteAdminManagementModels>(
    client: SiteAdminManagementClient<Models>,
    prepare?: (context: EntryPrepareContext) => void | Promise<void>,
    identity: MaybeRefOrGetter<string> = 'request',
) => {
    const owner = getCurrentScope()
    const descriptors = () => client.models()
    const present = async <Data extends Record<string, unknown>>(entry: SiteAdminEntry<Data>) => {
        const scope = toValue(identity)
        const descriptor = (await descriptors()).models[entry.model]
        if (scope !== toValue(identity)) throw new DOMException('Authentication changed.', 'AbortError')
        if (!descriptor) throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', 'Model is unavailable.', 403)
        return { ...entry, data: presentSiteAdminData<Data>(descriptor, entry.data, client.assetUrl) }
    }
    const resource = async (model: string, target?: Target) => {
        const scope = toValue(identity)
        const descriptor = (await descriptors()).models[model]
        if (!descriptor) throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', 'Model is unavailable.', 403)
        const entry = target ? await client.getEntry(target.id) : null
        if (scope !== toValue(identity)) throw new DOMException('Authentication changed.', 'AbortError')
        if (entry && (entry.version !== target!.version || entry.model !== model))
            throw new SiteAdminClientError('SITE_ADMIN_CONFLICT', 'Reload the current entry before saving.', 409)
        if (owner && !owner.active) throw new DOMException('Scope disposed.', 'AbortError')
        const create = () =>
            createSiteAdminModel<Record<string, unknown>>(
                { data: shallowRef(entry), status: ref('success'), error: shallowRef(), refresh: async () => {} },
                {
                    model,
                    descriptor: shallowRef(descriptor),
                    id: ref(target?.id ?? null),
                    identity: () => toValue(identity) + ':' + model + ':' + (target?.id ?? 'new'),
                    locale: undefined,
                    client: client as unknown as SiteAdminManagementClient<Record<string, Record<string, unknown>>>,
                    drafts: {},
                    ...(prepare ? { prepare } : {}),
                },
            )
        return owner ? owner.run(create)! : create()
    }
    const selected = async (target: Target) => ({ entry: await client.getEntry(target.id), target })
    const action = async (target: Target) => {
        const { entry } = await selected(target)
        return resource(entry.model, target)
    }
    return {
        entries: {
            list: async <Name extends Extract<keyof Models, string>>(model: Name, options?: ManagementListOptions) => {
                const page = await client.listEntries(model, options)
                return { ...page, items: await Promise.all(page.items.map(present)) }
            },
            get: async (id: string) => present(await client.getEntry(id)),
            create: async <Name extends Extract<keyof Models, string>>(model: Name, value: Models[Name]) =>
                (await resource(model)).save(value),
            update: async (target: Target, value: Record<string, unknown>) => (await action(target)).save(value),
            remove: async (target: Target) => (await action(target)).remove(),
            publish: async (target: Target, value?: Record<string, unknown>) =>
                (await action(target)).publish(undefined, value),
            unpublish: async (target: Target) => (await action(target)).unpublish(),
            schedule: async (target: Target, at: string, value?: Record<string, unknown>) =>
                (await action(target)).schedule(at, undefined, value),
            cancelSchedule: async (target: Target) => (await action(target)).cancelSchedule(),
            reorder: async <Name extends Extract<keyof Models, string>>(
                model: Name,
                entries: SiteAdminEntry<Models[Name]>[],
            ) => (await resource(model)).reorder(entries),
            references: (id: string, options: SiteAdminReferencesOptions) => client.referencesTo(id, options),
        },
        revisions: {
            list: async (id: string) => {
                const entry = await client.getEntry(id)
                const descriptor = (await descriptors()).models[entry.model]
                if (!descriptor) throw new SiteAdminClientError('SITE_ADMIN_FORBIDDEN', 'Model is unavailable.', 403)
                return (await client.listRevisions(id)).map((revision) => ({
                    ...revision,
                    data: presentSiteAdminData<Models[keyof Models]>(descriptor, revision.data, client.assetUrl),
                }))
            },
            restore: async (target: Target, revisionId: string) => (await action(target)).restore(revisionId),
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
