import type { SiteAdminConfig } from '../packages/site-admin/src/config'
import type {
    SiteAdminDatabase,
    SiteAdminStorage,
    StorageAssetCopy,
    StorageAssetSyncLease,
    StorageAssetCopyGuard,
    StorageRevisionCandidate,
    StorageEntryState,
    StorageRoute,
    StorageContentCommit,
    StorageCondition,
    StorageEntryFilter,
} from '../packages/site-admin/src/adapter'
import type { AssetRecord, EntryRecord, IncomingReference } from '../packages/site-admin/src/server/types'
import { SiteAdminError } from '../packages/site-admin/src/errors'

/** Deliberately SQL/ORM-free test backend, with domain objects and atomic copy-on-write commits. */
export function createMemoryDatabase() {
    type State = {
        entries: Map<string, StorageEntryState>
        revisions: Map<string, StorageRevisionCandidate>
        routes: Map<string, StorageRoute>
        assets: Map<string, AssetRecord>
        copies: Map<string, StorageAssetCopy>
        generation: number
        lease?: StorageAssetSyncLease
        storage?: string
    }
    let state: State = {
        entries: new Map(),
        revisions: new Map(),
        routes: new Map(),
        assets: new Map(),
        copies: new Map(),
        generation: 0,
    }
    let config: SiteAdminConfig = { models: {} }
    const clone = <T>(value: T): T => structuredClone(value)
    const conflict = () => {
        throw new SiteAdminError('SITE_ADMIN_CONFLICT', 'The record changed before commit.')
    }
    const materializeEntry = (value: StorageEntryState): EntryRecord => {
        const revision = state.revisions.get(value.currentRevisionId)!
        return clone({ ...value, revisionId: revision.id, data: revision.data, slug: revision.slug })
    }
    const matches = (value: EntryRecord, filter: StorageEntryFilter) =>
        (filter.models ?? Object.keys(config.models)).includes(value.model) &&
        (filter.locale === undefined || filter.locale === value.locale) &&
        (!filter.q ||
            value.slug.toLowerCase().includes(filter.q.toLowerCase()) ||
            JSON.stringify(value.data).toLowerCase().includes(filter.q.toLowerCase()))
    const entries = (filter: StorageEntryFilter = {}) =>
        [...state.entries.values()]
            .map(materializeEntry)
            .filter((value) => matches(value, filter))
            .sort(
                (a, b) =>
                    Number(a.sortOrder === null) - Number(b.sortOrder === null) ||
                    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
                    b.updatedAt.localeCompare(a.updatedAt) ||
                    a.id.localeCompare(b.id),
            )
    const allRelations = () =>
        [...state.revisions.values()].flatMap((revision) => revision.relations.map((ref) => ({ revision, ref })))
    const incoming = (
        id: string,
        options: Parameters<SiteAdminStorage['incomingReferences']>[1],
    ): IncomingReference[] =>
        allRelations()
            .flatMap(({ revision, ref }) => {
                const source = state.entries.get(revision.entryId)
                return source &&
                    (options.view === 'published' ? source.publishedRevisionId : source.currentRevisionId) ===
                        revision.id &&
                    ref.id === id &&
                    (!options.from || source.model === options.from) &&
                    (!options.field || ref.path === options.field) &&
                    (!options.required || ref.required) &&
                    (!options.excludeSelf || source.id !== id)
                    ? [
                          {
                              entryId: source.id,
                              model: source.model,
                              field: ref.path,
                              revisionId: revision.id,
                              view: options.view,
                          },
                      ]
                    : []
            })
            .sort(
                (a, b) =>
                    a.model.localeCompare(b.model) ||
                    a.entryId.localeCompare(b.entryId) ||
                    a.field.localeCompare(b.field),
            )
    const hasAssetRefs = (id: string) =>
        [...state.revisions.values()].some((revision) => revision.assets.some((ref) => ref.id === id))
    const condition = (value: StorageCondition) => {
        switch (value.kind) {
            case 'entryVersion': {
                const entry = state.entries.get(value.id)
                return entry?.version === value.version && (value.model === undefined || entry.model === value.model)
            }
            case 'assetsReady':
                return value.ids.every((id) => state.assets.get(id)?.state === 'ready')
            case 'relations':
                return value.targets.every(
                    ({ id, model, published }) =>
                        state.entries.get(id)?.model === model &&
                        (!published || state.entries.get(id)?.publishedRevisionId != null),
                )
            case 'noRetainedRelations':
                return !allRelations().some(({ ref }) => ref.id === value.id)
            case 'noRequiredPublicReferences':
                return !incoming(value.id, { view: 'published', required: true, excludeSelf: true }).some((ref) =>
                    value.models.includes(ref.model),
                )
        }
    }
    const copyGuard = (guard?: StorageAssetCopyGuard) =>
        !guard ||
        (state.lease?.id === guard.lease.id &&
            state.lease.expiresAt === guard.lease.expiresAt &&
            guard.now < state.lease.expiresAt &&
            (guard.generation === undefined || state.generation === guard.generation))
    const storage: SiteAdminStorage = {
        assertSchema: async () => {},
        readEntry: async (id) => (state.entries.has(id) ? materializeEntry(state.entries.get(id)!) : undefined),
        entries: async (filter) => entries(filter),
        pageEntries: async (filter, page) => {
            const values = entries(filter)
            return { items: values.slice(page.offset, page.offset + page.limit), total: values.length }
        },
        readRevision: async (id, entryId) => {
            const value = state.revisions.get(id)
            if (!value || (entryId !== undefined && value.entryId !== entryId)) return undefined
            const { assets: _assets, relations: _relations, model: _model, ...revision } = value
            return clone(revision)
        },
        revisions: async (entryId) => {
            const ids = await storage.revisionIds(entryId)
            return Promise.all(ids.map(async (id) => (await storage.readRevision(id))!))
        },
        revisionIds: async (entryId) =>
            [...state.revisions.values()]
                .filter((revision) => revision.entryId === entryId)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
                .map(({ id: revisionId }) => revisionId),
        pruneRevisions: async (entryId, candidates) => {
            const value = state.entries.get(entryId),
                deleted: string[] = []
            for (const id of candidates) {
                if (
                    state.revisions.get(id)?.entryId !== entryId ||
                    [value?.currentRevisionId, value?.publishedRevisionId, value?.scheduledRevisionId].includes(id) ||
                    [...state.routes.values()].some((route) => route.revisionId === id)
                )
                    continue
                state.revisions.delete(id)
                deleted.push(id)
            }
            return deleted
        },
        referenceTargets: async (ids) =>
            ids.flatMap((id) => {
                const value = state.entries.get(id)
                return value ? [{ id, model: value.model, publishedRevisionId: value.publishedRevisionId }] : []
            }),
        incomingReferences: async (id, options) => clone(incoming(id, options)),
        hasRetainedRelations: async (id) => allRelations().some(({ ref }) => ref.id === id),
        published: async (filter = {}) =>
            [...state.entries.values()]
                .filter(
                    (entry) =>
                        entry.publishedRevisionId &&
                        entry.publishedAt &&
                        (!filter.model || entry.model === filter.model) &&
                        (!filter.ids || filter.ids.includes(entry.id)) &&
                        (filter.locale === undefined || entry.locale === filter.locale) &&
                        (!filter.translationGroups || filter.translationGroups.includes(entry.translationGroup)),
                )
                .sort(
                    (a, b) =>
                        Number(a.sortOrder === null) - Number(b.sortOrder === null) ||
                        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
                        b.publishedAt!.localeCompare(a.publishedAt!) ||
                        a.id.localeCompare(b.id),
                )
                .flatMap((entry) => {
                    const revision = state.revisions.get(entry.publishedRevisionId!)!
                    return filter.key === undefined || filter.key === entry.id || filter.key === revision.slug
                        ? [
                              clone({
                                  id: entry.id,
                                  model: entry.model,
                                  locale: entry.locale,
                                  publishedAt: entry.publishedAt!,
                                  revisionId: revision.id,
                                  data: revision.data,
                                  slug: revision.slug,
                                  translationGroup: entry.translationGroup,
                              }),
                          ]
                        : []
                }),
        routes: async (filter = {}) =>
            clone(
                [...state.routes.values()]
                    .filter(
                        (route) =>
                            (filter.entryId === undefined || route.entryId === filter.entryId) &&
                            (!filter.kinds || filter.kinds.includes(route.kind)) &&
                            (!filter.locales || filter.locales.includes(route.locale)) &&
                            (filter.path === undefined || route.path === filter.path),
                    )
                    .sort((a, b) => a.locale.localeCompare(b.locale) || a.path.localeCompare(b.path)),
            ),
        scheduledBefore: async (now) =>
            [...state.entries.values()]
                .filter((entry) => entry.scheduledRevisionId && entry.scheduledAt! <= now)
                .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
                .map((entry) => ({ id: entry.id, revisionId: entry.scheduledRevisionId!, version: entry.version })),
        publicGeneration: async () => state.generation,
        commit: async (input: StorageContentCommit) => {
            if (!(input.conditions ?? []).every(condition)) conflict()
            const before = state
            state = clone(state)
            try {
                if (input.create) {
                    if (state.entries.has(input.create.id)) conflict()
                    state.entries.set(input.create.id, clone(input.create))
                }
                for (const revision of input.revisions ?? []) {
                    if (state.revisions.has(revision.id)) conflict()
                    state.revisions.set(revision.id, clone(revision))
                }
                for (const change of input.routes ?? []) {
                    if (change.kind === 'put') {
                        const key = change.route.locale + '\0' + change.route.path
                        if (state.routes.has(key))
                            throw new SiteAdminError(
                                'SITE_ADMIN_ROUTE_CONFLICT',
                                'Another public route already owns this path.',
                            )
                        state.routes.set(key, clone(change.route))
                    } else
                        for (const [key, route] of state.routes) {
                            if (route.entryId !== change.entryId) continue
                            if (change.kind === 'retargetHistory') {
                                if (route.kind === 'historical')
                                    state.routes.set(key, { ...route, targetPath: change.path, status: change.status })
                            } else if (
                                (change.path === undefined || change.path === route.path) &&
                                (!change.kinds || change.kinds.includes(route.kind))
                            )
                                state.routes.delete(key)
                        }
                }
                for (const update of input.updates ?? []) {
                    const value = state.entries.get(update.id)
                    if (!value) conflict()
                    state.entries.set(update.id, { ...value!, ...clone(update.patch), version: value!.version + 1 })
                }
                if (input.delete) {
                    if (!state.entries.delete(input.delete)) conflict()
                    for (const [id, revision] of state.revisions)
                        if (revision.entryId === input.delete) state.revisions.delete(id)
                }
                if (input.publicGeneration) state.generation++
            } catch (error) {
                state = before
                throw error
            }
        },
        readAsset: async (id) => clone(state.assets.get(id)),
        assets: async (filter = {}) =>
            clone(
                [...state.assets.values()].filter(
                    (asset) =>
                        (!filter.ids || filter.ids.includes(asset.id)) &&
                        (filter.state === undefined || filter.state === asset.state) &&
                        (filter.storage === undefined || filter.storage === asset.storage),
                ),
            ),
        assetGCCandidates: async (cutoff, now) =>
            clone(
                [...state.assets.values()].filter(
                    (asset) =>
                        !hasAssetRefs(asset.id) &&
                        (['ready', 'delete_failed', 'upload_failed'].includes(asset.state)
                            ? asset.createdAt <= cutoff
                            : ['uploading', 'deleting'].includes(asset.state) && asset.leaseExpiresAt! <= now),
                ),
            ),
        hasAssetReferences: async (id) => hasAssetRefs(id),
        publishedAssetSources: async (id) =>
            [...state.entries.values()]
                .filter(
                    (entry) =>
                        entry.publishedRevisionId &&
                        state.revisions.get(entry.publishedRevisionId)!.assets.some((ref) => ref.id === id),
                )
                .map(({ id: entryId }) => entryId),
        insertAsset: async (asset) => {
            if (state.assets.has(asset.id)) conflict()
            state.assets.set(asset.id, clone(asset))
        },
        finishAssetUpload: async (id, token, ready, now) => {
            const asset = state.assets.get(id)
            if (asset?.state !== 'uploading' || asset.operationToken !== token) return false
            state.assets.set(id, {
                ...asset,
                ...(ready ?? {}),
                state: ready ? 'ready' : 'upload_failed',
                operationToken: null,
                leaseExpiresAt: null,
                updatedAt: now,
            })
            return true
        },
        claimAssetDeletion: async (id, token, leaseExpiresAt, now) => {
            const asset = state.assets.get(id)
            if (
                !asset ||
                hasAssetRefs(id) ||
                (!['ready', 'delete_failed', 'upload_failed'].includes(asset.state) &&
                    (!['uploading', 'deleting'].includes(asset.state) ||
                        !asset.leaseExpiresAt ||
                        asset.leaseExpiresAt > now))
            )
                return false
            state.assets.set(id, { ...asset, state: 'deleting', operationToken: token, leaseExpiresAt, updatedAt: now })
            return true
        },
        finishAssetDeletion: async (id, token, success, now) => {
            const asset = state.assets.get(id)
            if (asset?.state !== 'deleting' || asset.operationToken !== token) return false
            state.assets.set(id, {
                ...asset,
                state: success ? 'deleted' : 'delete_failed',
                operationToken: null,
                leaseExpiresAt: null,
                updatedAt: now,
            })
            return true
        },
        assetStorageMode: async () => (state.storage ? { separate: true, storage: state.storage } : undefined),
        bindAssetStorageMode: async (storageName) => {
            if (state.storage && state.storage !== storageName) conflict()
            state.storage = storageName
        },
        hasLegacyAssetOriginals: async () =>
            [...state.assets.values()].some((asset) => asset.storage !== 'draft' && asset.state !== 'deleted'),
        assetCopies: async () => clone([...state.copies].map(([ledger, copy]) => ({ ledger, copy }))),
        claimAssetSync: async (lease, now) => {
            if (state.lease && state.lease.expiresAt > now) return false
            state.lease = clone(lease)
            return true
        },
        releaseAssetSync: async (lease) => {
            if (state.lease?.id === lease.id && state.lease.expiresAt === lease.expiresAt) delete state.lease
        },
        createAssetCopy: async (ledger, copy, guard) => {
            if (!copyGuard(guard) || state.copies.has(ledger)) return false
            state.copies.set(ledger, clone(copy))
            return true
        },
        updateAssetCopy: async (ledger, copy, guard) => {
            if (!copyGuard(guard) || !state.copies.has(ledger)) return false
            state.copies.set(ledger, clone(copy))
            return true
        },
        statistics: async () => ({
            entries: Object.keys(config.models).flatMap((model) => {
                const values = [...state.entries.values()].filter((entry) => entry.model === model)
                return values.length
                    ? [
                          {
                              model,
                              total: values.length,
                              published: values.filter((e) => e.publishedRevisionId).length,
                              drafts: values.filter((e) => e.currentRevisionId !== e.publishedRevisionId).length,
                              scheduled: values.filter((e) => e.scheduledRevisionId).length,
                          },
                      ]
                    : []
            }),
            assets: [...new Set([...state.assets.values()].map(({ state: status }) => status))]
                .sort()
                .map((status) => ({
                    state: status,
                    count: [...state.assets.values()].filter((value) => value.state === status).length,
                })),
            orphanAssets: [...state.assets.values()].filter(
                (asset) => ['ready', 'delete_failed', 'upload_failed'].includes(asset.state) && !hasAssetRefs(asset.id),
            ).length,
        }),
    }
    return {
        storage,
        snapshot: () => clone(state),
        bind(definition: SiteAdminConfig) {
            config = definition
            return storage
        },
    } satisfies SiteAdminDatabase & { storage: SiteAdminStorage; snapshot: () => State }
}
