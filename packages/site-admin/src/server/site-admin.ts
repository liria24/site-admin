import type { ComarkContent, ContentFile } from 'comark-content'
import { createMarkdownContent } from '../markdown/content'
import { resolveMarkdownSource } from '../markdown/assets'
import { astText, cleanText, collectMarkdown, markdownDocument, type MarkdownDocumentValue } from '../markdown/document'
import { addRoute, createRouter, findRoute, type RouterContext } from 'rou3'
import type { SiteAdminStorage } from '../adapter'
import { prepareUpload, safeFilename, detectedMime } from './upload'
import { resolveSiteAdminAssets } from '../assets-config'
import type { Files } from 'files-sdk'

import type {
    ModelDefinition,
    SiteAdminAssetAction,
    SiteAdminLifecycleEvent,
    SiteAdminModelAction,
    SiteAdminSystemAction,
} from '../config'
import { createSiteAdminDescriptor, type SiteAdminDescriptor } from '../descriptor'
import { SiteAdminError, type SiteAdminIssue } from '../errors'
import { createSiteAdminRouteResolver, serializeSiteAdminSeo, type SiteAdminRouteResolver } from '../seo'
import type { AnyField, AssetInput, FieldRecord } from '../fields'
import {
    applyFieldDefaults,
    collectReferences,
    fieldAtPath,
    projectStoredFields,
    validateModelData,
    type IndexedReference,
} from '../validation'
import type {
    StoragePublishedEntry,
    StorageRoute,
    StorageRouteChange,
    StorageRevisionCandidate,
    StorageContentCommit,
    StorageCondition,
    StorageAssetCopy,
    StorageAssetCopyGuard,
    StorageEntryFilter,
} from '../storage'
import { entryPath, modelRouteOptions, preferredSlugSource, routeRedirect, slugify, validateSlug } from './routes'
import type {
    AssetRecord,
    AssetSyncResult,
    DownloadedAsset,
    EntryInput,
    EntryRecord,
    IncomingReference,
    PublicEntry,
    PublicEntrySeo,
    PublishDueResult,
    PublishEntryInput,
    RevisionRecord,
    SiteAdminDiagnostic,
    SiteAdminInspection,
    SiteAdminOptions,
    UpdateEntryInput,
    UploadAssetInput,
} from './types'

type EntryRow = EntryRecord
type RevisionRow = RevisionRecord
type ReferenceTargetRow = { id: string; model: string; publishedRevisionId: string | null }
type AssetRow = AssetRecord
type PublishedRow = StoragePublishedEntry
type RouteRow = StorageRoute

interface LLMSEntry {
    content?: string
    description?: string
    href: string
    title: string
}

interface ProjectionBudget {
    alternates?: Map<string, Array<{ locale: string; path: string }>>
    nodes: number
}

type AssetCopy = StorageAssetCopy

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const stableJson = (value: unknown): string =>
    JSON.stringify(value, (_, item: unknown) =>
        isObject(item)
            ? Object.fromEntries(Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)))
            : item,
    )

const safeId = (value: string, label: string): string => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `${label} contains unsupported characters.`)
    }
    return value
}

const mimeMatches = (value: string, accepted: readonly string[]): boolean =>
    accepted.some((entry) => entry === value || (entry.endsWith('/*') && value.startsWith(entry.slice(0, -1))))

const durationMilliseconds = (value: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isFinite(value * 1000))
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Asset durations must be finite non-negative seconds.')
    return value * 1000
}

export class SiteAdmin<Context = unknown> {
    readonly #storage: SiteAdminStorage
    readonly diagnostics: SiteAdminDiagnostic[] = []
    readonly #options: SiteAdminOptions<Context>
    readonly #descriptor: SiteAdminDescriptor
    readonly #resolveRouteRule: SiteAdminRouteResolver
    readonly #content = new Map<string, { content: ComarkContent; generation: number }>()
    readonly #parsedContent = new Map<string, { file: ContentFile; generation: number }>()
    readonly #routes = new Map<string, { generation: number; router: RouterContext<RouteRow> }>()
    #initializer: Promise<void> | undefined

    constructor(options: SiteAdminOptions<Context>) {
        if (options.config.assets)
            options = {
                ...options,
                config: { ...options.config, assets: resolveSiteAdminAssets(options.config.assets, options.config)! },
            }
        if (typeof options.database?.bind !== 'function')
            throw new SiteAdminError('SITE_ADMIN_DATABASE_UNSUPPORTED', 'Provide a Site Admin storage adapter.')
        this.#storage = options.database.bind(options.config)

        durationMilliseconds(options.config.assets?.cleanup?.minimumAge ?? 60 * 60 * 24)
        durationMilliseconds(options.config.assets?.operationLeaseSeconds ?? 60 * 15)
        if (
            options.config.assets?.separateDrafts === true &&
            (options.config.assets.operationLeaseSeconds ?? 60 * 15) === 0
        )
            throw new SiteAdminError(
                'SITE_ADMIN_INVALID_INPUT',
                'separateDrafts requires a positive operationLeaseSeconds.',
            )
        const maxSize = options.config.assets?.maxUploadSize
        if (maxSize !== undefined && (!Number.isSafeInteger(maxSize) || maxSize <= 0))
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'maxUploadSize must be a positive safe integer.')
        this.#options = options
        this.#resolveRouteRule = createSiteAdminRouteResolver(options.config.routeRules)
        this.#descriptor = createSiteAdminDescriptor(options.config)
    }

    get config(): SiteAdminOptions<Context>['config'] {
        return this.#options.config
    }

    get descriptor(): SiteAdminDescriptor {
        return structuredClone(this.#descriptor)
    }

    descriptorFor(actor: import('./types').SiteAdminActor): SiteAdminDescriptor {
        const descriptor = this.descriptor
        descriptor.models = Object.fromEntries(
            Object.entries(descriptor.models).filter(([modelName]) => this.can(actor, 'model', 'readDraft', modelName)),
        )
        if (!this.can(actor, 'asset', 'read')) descriptor.assets = false
        return descriptor
    }

    async authorizeRequest(request: Request, context?: Context): Promise<import('./types').SiteAdminActor> {
        const actor = await this.#options.authorize?.(request, context)
        if (!actor?.id) throw new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'Authentication is required.')
        return actor
    }

    can(
        actor: import('./types').SiteAdminActor,
        kind: 'asset' | 'model' | 'system',
        action: SiteAdminAssetAction | SiteAdminModelAction | SiteAdminSystemAction,
        modelName?: string,
    ): boolean {
        if (actor.roles?.includes('admin')) return true
        for (const role of actor.roles ?? []) {
            const definition = this.config.authorization?.roles[role]
            if (!definition) continue
            if (kind === 'asset' && definition.assets?.includes(action as SiteAdminAssetAction)) return true
            if (kind === 'system' && definition.system?.includes(action as SiteAdminSystemAction)) return true
            if (
                kind === 'model' &&
                modelName &&
                (definition.models?.[modelName]?.includes(action as SiteAdminModelAction) ||
                    definition.models?.['*']?.includes(action as SiteAdminModelAction))
            )
                return true
        }
        return false
    }

    assertPermission(
        actor: import('./types').SiteAdminActor,
        kind: 'asset' | 'model' | 'system',
        action: SiteAdminAssetAction | SiteAdminModelAction | SiteAdminSystemAction,
        modelName?: string,
    ): void {
        if (!this.can(actor, kind, action, modelName)) {
            throw new SiteAdminError('SITE_ADMIN_FORBIDDEN', 'This role is not allowed to perform that operation.')
        }
    }

    initialize(): Promise<void> {
        this.#initializer ??= this.#initialize()
        void this.#initializer.catch(() => {
            this.#initializer = undefined
        })
        return this.#initializer
    }

    async #initialize(): Promise<void> {
        this.#validateConfig()
        await this.#storage.assertSchema()
        const mode = await this.#storage.assetStorageMode()
        const assets = this.config.assets
        if (
            mode &&
            (mode.separate !== (assets?.separateDrafts === true) || (mode.separate && mode.storage !== assets?.storage))
        )
            throw new SiteAdminError(
                'SITE_ADMIN_MIGRATION_REQUIRED',
                'Migrate existing Asset copies before changing the storage mode.',
            )
        if (assets?.separateDrafts === true) {
            await this.#assetStores()
            if (await this.#storage.hasLegacyAssetOriginals())
                throw new SiteAdminError(
                    'SITE_ADMIN_MIGRATION_REQUIRED',
                    'Move existing Asset originals to private draft storage before enabling separateDrafts.',
                )
            await this.#storage.bindAssetStorageMode(assets.storage!)
        }

        await this.#reconcileRoutes()
        if (assets?.separateDrafts === true) {
            const sync = await this.#syncAssetCopies()
            if (sync.failed.length)
                this.diagnostics.push({
                    code: 'SITE_ADMIN_ASSET_SYNC_FAILED',
                    message: 'Asset copies need retry through publishDue or Asset GC.',
                })
        }
    }

    #validateConfig(): void {
        for (const [modelName, definition] of Object.entries(this.config.models)) {
            safeId(modelName, 'Model name')
            if (Object.hasOwn(definition.fields, '_siteAdmin')) {
                throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"_siteAdmin" is reserved for public metadata.')
            }
            for (const [fieldName, field] of Object.entries(definition.fields)) {
                safeId(fieldName, `Field name in model "${modelName}"`)
                this.#validateFieldConfig(field)
            }
            const route = modelRouteOptions(definition)
            if (route?.redirect) {
                const field = definition.fields[route.redirect]
                if (field?.kind !== 'url') {
                    throw new SiteAdminError(
                        'SITE_ADMIN_INVALID_INPUT',
                        `Redirect field "${route.redirect}" in model "${modelName}" must be a URL field.`,
                    )
                }
            }
            if (definition.route) entryPath(modelName, definition, 'config-check', this.#apiBases())
        }
    }

    #validateFieldConfig(field: AnyField): void {
        if (field.kind === 'relation' && !Object.hasOwn(this.config.models, field.model)) {
            throw new SiteAdminError(
                'SITE_ADMIN_INVALID_INPUT',
                `Relation target model "${field.model}" does not exist.`,
            )
        }
        if (field.kind === 'object') {
            for (const [name, child] of Object.entries(field.fields)) {
                safeId(name, 'Nested field name')
                this.#validateFieldConfig(child)
            }
        }
        if (field.kind === 'array') this.#validateFieldConfig(field.item)
    }

    #model(name: string): ModelDefinition {
        const definition = this.config.models[name]
        if (!definition) throw new SiteAdminError('SITE_ADMIN_MODEL_NOT_FOUND', `Unknown model "${name}".`)
        return definition
    }

    #publicModel(name: string): ModelDefinition | undefined {
        const definition = this.config.models[name]
        return definition?.public === false ? undefined : definition
    }

    #locale(definition: ModelDefinition, locale?: string): string {
        if (!definition.localized) return ''
        const normalized = locale || this.#options.locales?.defaultLocale
        if (!normalized) {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'A locale is required for localized content.')
        }
        if (this.#options.locales?.supported && !this.#options.locales.supported.includes(normalized)) {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Unsupported locale "${normalized}".`)
        }
        return normalized
    }

    #localizedPath(definition: ModelDefinition, path: string, locale: string): string {
        return definition.localized && this.#options.locales?.localizePath
            ? this.#options.locales.localizePath(path, locale)
            : path
    }

    #entryRow(id: string): Promise<EntryRecord | undefined> {
        return this.#storage.readEntry(id)
    }

    async #requiredEntry(id: string): Promise<EntryRow> {
        const row = await this.#entryRow(id)
        if (!row) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', `Entry "${id}" does not exist.`)
        return row
    }

    async getEntry(id: string): Promise<EntryRecord> {
        await this.initialize()
        return this.#requiredEntry(id)
    }

    async listEntries(modelName?: string): Promise<EntryRecord[]> {
        await this.initialize()
        if (modelName) this.#model(modelName)
        return this.#storage.entries(modelName ? { models: [modelName] } : {})
    }

    async pageEntries(
        filter: StorageEntryFilter,
        page: { limit: number; offset: number },
    ): Promise<{ items: EntryRecord[]; total: number }> {
        await this.initialize()
        for (const model of filter.models ?? []) this.#model(model)
        return this.#storage.pageEntries(filter, page)
    }

    async listRevisions(entryId: string): Promise<RevisionRecord[]> {
        await this.initialize()
        await this.#requiredEntry(entryId)
        return this.#storage.revisions(entryId)
    }

    async referencesTo(
        entryId: string,
        options: { field?: string; from?: string; view: 'current' | 'published' },
    ): Promise<IncomingReference[]> {
        await this.initialize()
        await this.#requiredEntry(entryId)
        if (options.from) this.#model(options.from)
        if (options.view !== 'current' && options.view !== 'published')
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'view must be current or published.')
        return this.#storage.incomingReferences(entryId, options)
    }

    async restoreRevision(
        entryId: string,
        revisionId: string,
        input: { actorId?: string; expectedVersion: number },
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const definition = this.#model(entry.model)
        const revision = await this.#revision(revisionId, entryId)
        const prepared = await this.#prepareRevision(definition, revision)
        await this.#assertPublishableRelations(definition, prepared.relations, entryId)
        const restoredRevisionId = this.#id()
        const time = this.#now()
        await this.#commit({
            conditions: [
                this.#guard(entryId, input.expectedVersion),
                ...this.#referenceGuard(definition, prepared, true),
            ],
            revisions: [
                this.#revisionCandidate({
                    ...(input.actorId ? { actorId: input.actorId } : {}),
                    ...prepared,
                    entryId,
                    model: definition,
                    revisionId: restoredRevisionId,
                    slug: revision.slug,
                    time,
                }),
            ],
            updates: [{ id: entryId, patch: { currentRevisionId: restoredRevisionId, updatedAt: time } }],
        })

        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            revisionId: restoredRevisionId,
            type: 'restore',
        })
        return this.getEntry(entryId)
    }

    async pruneRevisions(entryId: string, retain: number): Promise<{ deleted: string[] }> {
        await this.initialize()
        await this.#requiredEntry(entryId)
        if (!Number.isInteger(retain) || retain < 0) {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"retain" must be a non-negative integer.')
        }
        const candidates = (await this.#storage.revisionIds(entryId)).slice(retain)
        return { deleted: await this.#storage.pruneRevisions(entryId, candidates) }
    }

    async #revision(id: string, entryId?: string): Promise<RevisionRecord> {
        const row = await this.#storage.readRevision(id, entryId)
        if (!row) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', `Revision "${id}" does not exist.`)
        return row
    }

    #resolveSlug(
        definition: ModelDefinition,
        data: Record<string, unknown>,
        explicit: string | undefined,
        fallbackId: string,
    ): string {
        const maxLength = this.config.modelDefaults?.slug?.maxLength ?? 80
        if (explicit === '' && definition.publishing !== false) return ''
        if (explicit !== undefined) return validateSlug(explicit, maxLength)
        const generated = slugify(preferredSlugSource(definition, data) ?? '', maxLength)
        return validateSlug(generated || fallbackId, maxLength)
    }

    async #prepareData(
        definition: ModelDefinition,
        value: Record<string, unknown>,
        defaults: boolean,
    ): Promise<{ assets: IndexedReference[]; data: Record<string, unknown>; relations: IndexedReference[] }> {
        const data = defaults ? applyFieldDefaults(definition.fields, value) : value
        const validated = await validateModelData(definition, data)
        if (!validated.data) {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Model validation failed.', validated.issues)
        }
        const references = collectReferences(definition.fields, validated.data)
        await this.#assertReferences(definition, references)
        return { data: validated.data, ...references }
    }

    async #prepareRevision(
        definition: ModelDefinition,
        revision: RevisionRow,
    ): Promise<{ assets: IndexedReference[]; data: Record<string, unknown>; relations: IndexedReference[] }> {
        const stored = projectStoredFields(definition.fields, revision.data)
        const prepared = await this.#prepareData(definition, stored, false)
        if (stableJson(prepared.data) !== stableJson(stored)) {
            throw new SiteAdminError(
                'SITE_ADMIN_SCHEMA_MIGRATION_REQUIRED',
                'Validation transforms changed this revision; save the transformed data before publishing.',
            )
        }
        return prepared
    }

    async #assertReferences(
        definition: ModelDefinition,
        references: { assets: IndexedReference[]; relations: IndexedReference[] },
    ): Promise<void> {
        const issues: SiteAdminIssue[] = []
        const relationIds = [...new Set(references.relations.map((reference) => reference.id))]
        const relationTargets = new Map<string, ReferenceTargetRow>()
        if (relationIds.length > 0) {
            const rows = await this.#storage.referenceTargets(relationIds)

            for (const row of rows) relationTargets.set(row.id, row)
        }
        for (const reference of references.relations) {
            const target = relationTargets.get(reference.id)
            const field = fieldAtPath(definition.fields, reference.path)
            if (!target) issues.push({ message: `Entry "${reference.id}" does not exist.`, path: reference.path })
            else if (field?.kind === 'relation' && target.model !== field.model) {
                issues.push({ message: `Expected a ${field.model} entry.`, path: reference.path })
            }
        }

        const assetIds = [...new Set(references.assets.map((reference) => reference.id))]
        const assets = new Map<string, AssetRow>()
        if (assetIds.length > 0) {
            const rows = await this.#storage.assets({ ids: assetIds })

            for (const row of rows) assets.set(row.id, row)
        }
        for (const reference of references.assets) {
            const asset = assets.get(reference.id)
            const field = fieldAtPath(definition.fields, reference.path)
            if (!asset || asset.state !== 'ready') {
                issues.push({ message: `Asset "${reference.id}" is not ready.`, path: reference.path })
            } else if (field && 'accept' in field && field.accept && !mimeMatches(asset.contentType, field.accept)) {
                issues.push({
                    message: `Asset type "${asset.contentType}" is not accepted.`,
                    path: reference.path,
                })
            }
        }
        if (issues.length > 0) {
            const assetFailure = issues.some((entry) => entry.message.startsWith('Asset'))
            throw new SiteAdminError(
                assetFailure ? 'SITE_ADMIN_ASSET_NOT_READY' : 'SITE_ADMIN_INVALID_INPUT',
                'Referenced records are invalid.',
                issues,
            )
        }
    }

    #guard(entryId: string, expectedVersion: number): StorageCondition {
        return { kind: 'entryVersion', id: entryId, version: expectedVersion }
    }

    #referenceGuard(
        definition: ModelDefinition,
        references: { assets: IndexedReference[]; relations: IndexedReference[] },
        publishing: boolean,
    ): StorageCondition[] {
        const targets = new Map<string, { id: string; model: string; published: boolean }>()
        for (const reference of references.relations) {
            const field = fieldAtPath(definition.fields, reference.path)
            if (field?.kind === 'relation') {
                const key = `${reference.id}\0${field.model}`
                targets.set(key, {
                    id: reference.id,
                    model: field.model,
                    published: targets.get(key)?.published === true || (publishing && field.required === true),
                })
            }
        }
        return [
            { kind: 'assetsReady', ids: references.assets.map(({ id }) => id) },
            { kind: 'relations', targets: [...targets.values()] },
        ]
    }

    #revisionCandidate(input: {
        actorId?: string
        assets: IndexedReference[]
        data: Record<string, unknown>
        entryId: string
        model: ModelDefinition
        revisionId: string
        slug: string
        time: string
        relations: IndexedReference[]
    }): StorageRevisionCandidate {
        const modelName = Object.entries(this.config.models).find(([, definition]) => definition === input.model)?.[0]
        if (!modelName) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Unknown content Model.')
        return {
            id: input.revisionId,
            entryId: input.entryId,
            actorId: input.actorId ?? null,
            createdAt: input.time,
            data: input.data,
            slug: input.slug,
            model: modelName,
            assets: input.assets,
            relations: input.relations.map((reference) => {
                const field = fieldAtPath(input.model.fields, reference.path)
                return { ...reference, required: field?.kind === 'relation' && field.required === true }
            }),
        }
    }

    async #currentRoute(entryId: string): Promise<RouteRow | undefined> {
        return (await this.#storage.routes({ entryId, kinds: ['page', 'redirect'] }))[0]
    }

    async #routeChanges(input: {
        data: Record<string, unknown>
        definition: ModelDefinition
        entryId: string
        modelName: string
        locale: string
        revisionId: string
        slug: string
        time: string
    }): Promise<StorageRouteChange[]> {
        const redirect = routeRedirect(input.definition, input.data)
        const current = await this.#currentRoute(input.entryId)
        const basePath =
            this.#options.routing?.enabled === false ||
            (redirect && this.#options.routing?.redirects === false) ||
            input.definition.public === false
                ? null
                : entryPath(input.modelName, input.definition, input.slug, this.#apiBases())
        const path = basePath === null ? null : this.#localizedPath(input.definition, basePath, input.locale)
        const status = this.config.modelDefaults?.historicalRedirectStatus ?? 301
        const changes: StorageRouteChange[] = [
            { kind: 'retargetHistory', entryId: input.entryId, path, status },
            { kind: 'remove', entryId: input.entryId, kinds: ['page', 'redirect'] },
        ]
        if (!path) return changes
        changes.push({ kind: 'remove', entryId: input.entryId, path })
        if (current && current.path !== path && this.#options.routing?.preserveHistory !== false)
            changes.push({
                kind: 'put',
                route: {
                    path: current.path,
                    locale: current.locale,
                    entryId: input.entryId,
                    revisionId: input.revisionId,
                    kind: 'historical',
                    targetPath: path,
                    status,
                    createdAt: input.time,
                },
            })
        changes.push({
            kind: 'put',
            route: {
                path,
                locale: input.locale,
                entryId: input.entryId,
                revisionId: input.revisionId,
                kind: redirect ? 'redirect' : 'page',
                targetPath: redirect?.target ?? null,
                status: redirect?.status ?? null,
                createdAt: input.time,
            },
        })
        return changes
    }

    async #reconcileRoutes(): Promise<void> {
        const routes = await this.#storage.routes()
        const rows = await this.#publishedRows()
        const graph = await this.#publicSnapshot(rows)
        const routesByEntry = new Map<string, RouteRow[]>()
        for (const route of routes) {
            const list = routesByEntry.get(route.entryId) ?? []
            list.push(route)
            routesByEntry.set(route.entryId, list)
        }
        const statements: StorageRouteChange[] = []
        for (const entryId of routesByEntry.keys()) {
            const row = graph.get(entryId)
            const definition = row && this.#publicModel(row.model)
            if (!row || !definition?.route || this.#options.routing?.enabled === false) {
                statements.push({ kind: 'remove', entryId })
                routesByEntry.delete(entryId)
            }
        }
        const time = this.#now()
        for (const row of rows) {
            if (!graph.has(row.id)) continue
            const definition = this.#publicModel(row.model)
            if (!definition?.route || this.#options.routing?.enabled === false) continue
            const data = row.data
            const redirect = routeRedirect(definition, data)
            if (redirect && this.#options.routing?.redirects === false) {
                if (routesByEntry.has(row.id)) {
                    statements.push({ kind: 'remove', entryId: row.id })
                }
                continue
            }
            const basePath = entryPath(row.model, definition, row.slug, this.#apiBases())
            if (!basePath) continue
            const path = this.#localizedPath(definition, basePath, row.locale)
            const current = routesByEntry
                .get(row.id)
                ?.find((route) => route.kind === 'page' || route.kind === 'redirect')
            if (
                current?.path === path &&
                current.locale === row.locale &&
                current.revisionId === row.revisionId &&
                current.kind === (redirect ? 'redirect' : 'page') &&
                current.targetPath === (redirect?.target ?? null) &&
                current.status === (redirect?.status ?? null)
            )
                continue
            statements.push(
                ...(await this.#routeChanges({
                    data,
                    definition,
                    entryId: row.id,
                    locale: row.locale,
                    modelName: row.model,
                    revisionId: row.revisionId,
                    slug: row.slug,
                    time,
                })),
            )
        }
        if (statements.length > 0) await this.#commit({ routes: statements, publicGeneration: true })
    }

    #commit(input: StorageContentCommit): Promise<void> {
        return this.#storage.commit(input)
    }

    async #afterCommit(event: SiteAdminLifecycleEvent, publicGraphChanged = false): Promise<void> {
        const result = publicGraphChanged ? await this.#syncAssetCopies() : { copied: [], deleted: [], failed: [] }
        if (this.config.hooks?.afterCommit) {
            try {
                await this.config.hooks.afterCommit(event)
            } catch (error) {
                this.diagnostics.push({
                    code: 'SITE_ADMIN_HOOK_FAILED',
                    message: error instanceof Error ? error.message : 'A post-commit hook failed.',
                })
            }
        }
        this.#assertAssetSync(result)
    }

    #assertAssetSync(result: AssetSyncResult): void {
        if (result.failed.length)
            throw new SiteAdminError(
                'SITE_ADMIN_STORAGE_UNAVAILABLE',
                'The entry was saved, but Asset copies need retry through publishDue or Asset GC.',
            )
    }

    async createEntry(modelName: string, input: EntryInput): Promise<EntryRecord> {
        await this.initialize()
        const definition = this.#model(modelName)
        const locale = this.#locale(definition, input.locale)
        const id = safeId(input.id ?? this.#id(), 'Entry ID')
        const prepared = await this.#prepareData(definition, input.data, true)
        const slug = this.#resolveSlug(definition, prepared.data, input.slug, id)
        const revisionId = this.#id()
        const time = this.#now()
        const published = definition.publishing === false
        const publicGraphChanged = published && definition.public !== false
        if (published) await this.#assertPublishableRelations(definition, prepared.relations, id)
        await this.#commit({
            conditions: this.#referenceGuard(definition, prepared, published),
            create: {
                id,
                model: modelName,
                locale,
                translationGroup: input.translationGroup ?? id,
                sortOrder: input.sortOrder ?? null,
                version: 1,
                createdAt: time,
                updatedAt: time,
                publishedAt: published ? time : null,
                currentRevisionId: revisionId,
                publishedRevisionId: published ? revisionId : null,
                scheduledRevisionId: null,
                scheduledAt: null,
            },
            revisions: [
                this.#revisionCandidate({
                    ...(input.actorId ? { actorId: input.actorId } : {}),
                    ...prepared,
                    entryId: id,
                    model: definition,
                    revisionId,
                    slug,
                    time,
                }),
            ],
            routes: published
                ? await this.#routeChanges({
                      data: prepared.data,
                      definition,
                      entryId: id,
                      modelName,
                      locale,
                      revisionId,
                      slug,
                      time,
                  })
                : [],
            publicGeneration: publicGraphChanged,
        })
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId: id,
                model: modelName,
                revisionId,
                type: 'create',
            },
            publicGraphChanged,
        )
        return this.getEntry(id)
    }

    async updateEntry(entryId: string, input: UpdateEntryInput): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const definition = this.#model(entry.model)
        const prepared = await this.#prepareData(definition, input.data, false)
        const slug =
            input.slug === undefined ? entry.slug : this.#resolveSlug(definition, prepared.data, input.slug, entry.id)
        const revisionId = this.#id(),
            time = this.#now(),
            published = definition.publishing === false
        const publicGraphChanged = published && definition.public !== false
        if (published) await this.#assertPublishableRelations(definition, prepared.relations, entryId)
        await this.#commit({
            conditions: [
                this.#guard(entryId, input.expectedVersion),
                ...this.#referenceGuard(definition, prepared, published),
            ],
            revisions: [
                this.#revisionCandidate({
                    ...(input.actorId ? { actorId: input.actorId } : {}),
                    ...prepared,
                    entryId,
                    model: definition,
                    revisionId,
                    slug,
                    time,
                }),
            ],
            routes: published
                ? await this.#routeChanges({
                      data: prepared.data,
                      definition,
                      entryId,
                      modelName: entry.model,
                      locale: entry.locale,
                      revisionId,
                      slug,
                      time,
                  })
                : [],
            updates: [
                {
                    id: entryId,
                    patch: {
                        currentRevisionId: revisionId,
                        updatedAt: time,
                        ...(published ? { publishedRevisionId: revisionId, publishedAt: time } : {}),
                    },
                },
            ],
            publicGeneration: publicGraphChanged,
        })
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId,
                model: entry.model,
                revisionId,
                type: 'update',
            },
            publicGraphChanged,
        )
        return this.getEntry(entryId)
    }

    async #assertPublishableRelations(
        definition: ModelDefinition,
        references: IndexedReference[],
        entryId: string,
    ): Promise<void> {
        const required = references.filter((reference) => {
            const field = fieldAtPath(definition.fields, reference.path)
            return field?.kind === 'relation' && field.required
        })
        if (references.length === 0) return
        const ids = [...new Set(references.map((reference) => reference.id))]
        const rows = await this.#publishedRows(undefined, ids)
        const graph = await this.#publicSnapshot(rows)
        const published = new Set(graph.keys())
        const issues = required
            .filter((reference) => !published.has(reference.id))
            .map((reference) => ({
                message: `Required relation "${reference.id}" is not published.`,
                path: reference.path,
            }))
        if (issues.length > 0) {
            throw new SiteAdminError(
                'SITE_ADMIN_RELATION_BLOCKED',
                'Required relations must be published first.',
                issues,
            )
        }
        const budget = { nodes: 1 }
        for (const reference of references) {
            const target = graph.get(reference.id)
            if (target) this.#projectPublished(target, graph, new Set([entryId]), budget)
        }
    }

    async #publicationCandidate(entry: EntryRecord, input: PublishEntryInput, publishing: boolean) {
        const definition = this.#model(entry.model)
        if (input.draft !== undefined && input.revisionId !== undefined)
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'draft and revisionId are mutually exclusive.')
        if (
            input.draft !== undefined &&
            (!isObject(input.draft) ||
                !isObject(input.draft.data) ||
                (input.draft.slug !== undefined && typeof input.draft.slug !== 'string'))
        )
            throw new SiteAdminError(
                'SITE_ADMIN_INVALID_INPUT',
                'Publish draft must contain data and an optional slug.',
            )
        const revision = input.draft
            ? undefined
            : await this.#revision(input.revisionId ?? entry.currentRevisionId, entry.id)
        const slug = validateSlug(
            input.draft?.slug ?? revision?.slug ?? entry.slug,
            this.config.modelDefaults?.slug?.maxLength ?? 80,
        )
        const prepared = input.draft
            ? await this.#prepareData(definition, input.draft.data, false)
            : publishing
              ? await this.#prepareRevision(definition, revision!)
              : undefined
        const revisionId = revision?.id ?? this.#id()
        if (publishing) await this.#assertPublishableRelations(definition, prepared!.relations, entry.id)
        const time = this.#now()
        return {
            definition,
            prepared,
            revisionId,
            slug,
            time,
            conditions: [
                this.#guard(entry.id, input.expectedVersion),
                ...(prepared ? this.#referenceGuard(definition, prepared, publishing) : []),
            ],
            revisions:
                input.draft && prepared
                    ? [
                          this.#revisionCandidate({
                              ...(input.actorId ? { actorId: input.actorId } : {}),
                              ...prepared,
                              entryId: entry.id,
                              model: definition,
                              revisionId,
                              slug,
                              time,
                          }),
                      ]
                    : [],
        }
    }

    async publishEntry(entryId: string, input: PublishEntryInput): Promise<EntryRecord> {
        return this.#publishEntry(entryId, input, true)
    }

    async #publishEntry(entryId: string, input: PublishEntryInput, synchronize: boolean): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const candidate = await this.#publicationCandidate(entry, input, true)
        const { definition, prepared, revisionId, slug, time, conditions, revisions } = candidate
        await this.#commit({
            conditions,
            revisions,
            routes: await this.#routeChanges({
                data: prepared!.data,
                definition,
                entryId,
                modelName: entry.model,
                locale: entry.locale,
                revisionId,
                slug,
                time,
            }),
            publicGeneration: definition.public !== false,
            updates: [
                {
                    id: entryId,
                    patch: {
                        ...(input.draft ? { currentRevisionId: revisionId } : {}),
                        publishedRevisionId: revisionId,
                        publishedAt: time,
                        scheduledRevisionId: null,
                        scheduledAt: null,
                        updatedAt: time,
                    },
                },
            ],
        })
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId,
                model: entry.model,
                revisionId,
                type: 'publish',
            },
            synchronize && definition.public !== false,
        )
        return this.getEntry(entryId)
    }

    async #assertCanUnpublish(entryId: string): Promise<void> {
        const incoming = await this.#storage.incomingReferences(entryId, {
            view: 'published',
            required: true,
            excludeSelf: true,
        })

        const blocking = incoming.filter((reference) => this.#publicModel(reference.model))
        if (blocking.length > 0) {
            throw new SiteAdminError(
                'SITE_ADMIN_RELATION_BLOCKED',
                'Published entries contain required relations to this entry.',
                blocking.map((reference) => ({
                    message: 'Required published relation would be broken.',
                    path: reference.field,
                })),
            )
        }
    }

    #unpublishGuard(entryId: string): StorageCondition {
        return {
            kind: 'noRequiredPublicReferences',
            id: entryId,
            models: Object.entries(this.config.models)
                .filter(([, definition]) => definition.public !== false)
                .map(([name]) => name),
        }
    }

    async unpublishEntry(entryId: string, input: { actorId?: string; expectedVersion: number }): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        await this.#assertCanUnpublish(entryId)
        const publicGraphChanged = Boolean(this.#publicModel(entry.model) && entry.publishedRevisionId)
        await this.#commit({
            conditions: [this.#guard(entryId, input.expectedVersion), this.#unpublishGuard(entryId)],
            routes: [{ kind: 'remove', entryId }],
            publicGeneration: publicGraphChanged,
            updates: [
                {
                    id: entryId,
                    patch: {
                        publishedRevisionId: null,
                        scheduledRevisionId: null,
                        scheduledAt: null,
                        publishedAt: null,
                        updatedAt: this.#now(),
                    },
                },
            ],
        })
        await this.#afterCommit(
            { ...(input.actorId ? { actorId: input.actorId } : {}), entryId, model: entry.model, type: 'unpublish' },
            publicGraphChanged,
        )
        return this.getEntry(entryId)
    }

    async schedulePublish(entryId: string, input: PublishEntryInput & { at: Date | string }): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const at = input.at instanceof Date ? input.at : new Date(input.at)
        if (!Number.isFinite(at.getTime()) || at.getTime() <= this.#date().getTime())
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Scheduled publish time must be in the future.')
        const { revisionId, time, conditions, revisions } = await this.#publicationCandidate(entry, input, false)
        await this.#commit({
            conditions,
            revisions,
            updates: [
                {
                    id: entryId,
                    patch: {
                        ...(input.draft ? { currentRevisionId: revisionId } : {}),
                        scheduledRevisionId: revisionId,
                        scheduledAt: at.toISOString(),
                        updatedAt: time,
                    },
                },
            ],
        })
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            revisionId,
            type: 'schedule',
        })
        return this.getEntry(entryId)
    }

    async cancelScheduledPublish(entryId: string, input: { expectedVersion: number }): Promise<EntryRecord> {
        await this.initialize()
        await this.#requiredEntry(entryId)
        await this.#commit({
            conditions: [this.#guard(entryId, input.expectedVersion)],
            updates: [{ id: entryId, patch: { scheduledRevisionId: null, scheduledAt: null, updatedAt: this.#now() } }],
        })
        return this.getEntry(entryId)
    }

    async publishDue(now = this.#date()): Promise<PublishDueResult> {
        await this.initialize()
        const due = await this.#storage.scheduledBefore(now.toISOString())

        const result: PublishDueResult = { failed: [], published: [] }
        for (const entry of due) {
            try {
                await this.#publishEntry(
                    entry.id,
                    {
                        expectedVersion: Number(entry.version),
                        revisionId: entry.revisionId,
                    },
                    false,
                )
                result.published.push(entry.id)
            } catch (error) {
                result.failed.push({
                    entryId: entry.id,
                    message: error instanceof Error ? error.message : 'Scheduled publish failed.',
                })
            }
        }
        if (this.config.assets?.separateDrafts === true) result.assets = await this.#syncAssetCopies()
        return result
    }

    async setSortOrder(entryId: string, sortOrder: number | null, expectedVersion: number): Promise<EntryRecord> {
        const entry = await this.getEntry(entryId)
        return (await this.setSortOrders(entry.model, [{ id: entryId, sortOrder, expectedVersion }]))[0]!
    }

    async setSortOrders(
        model: string,
        items: Array<{ id: string; sortOrder: number | null; expectedVersion: number }>,
    ): Promise<EntryRecord[]> {
        await this.initialize()
        if (!this.#model(model).sortable) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Model is not sortable.')
        if (
            !Array.isArray(items) ||
            items.some(
                (item) =>
                    !item ||
                    typeof item.id !== 'string' ||
                    !Number.isSafeInteger(item.expectedVersion) ||
                    item.expectedVersion < 0 ||
                    (item.sortOrder !== null &&
                        (typeof item.sortOrder !== 'number' || !Number.isFinite(item.sortOrder))),
            ) ||
            new Set(items.map((item) => item.id)).size !== items.length
        )
            throw new SiteAdminError(
                'SITE_ADMIN_INVALID_INPUT',
                'Sort items require unique IDs, finite orders and non-negative integer versions.',
            )
        if (!items.length) return []
        const entries = await Promise.all(items.map(({ id }) => this.#entryRow(id)))
        const time = this.#now()
        await this.#commit({
            conditions: items.map(({ id, expectedVersion }) => ({
                kind: 'entryVersion',
                id,
                version: expectedVersion,
                model,
            })),
            publicGeneration: Boolean(this.#publicModel(model)) && entries.some((entry) => entry?.publishedRevisionId),
            updates: items.map((item, index) => ({
                id: item.id,
                patch: {
                    sortOrder: item.sortOrder,
                    updatedAt: time,
                    ...(entries[index]?.publishedRevisionId ? { publishedAt: time } : {}),
                },
            })),
        })
        return Promise.all(items.map((item) => this.getEntry(item.id)))
    }

    async deleteEntry(entryId: string, input: { actorId?: string; expectedVersion: number }): Promise<void> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const publicGraphChanged = Boolean(this.#publicModel(entry.model) && entry.publishedRevisionId)
        if (await this.#storage.hasRetainedRelations(entryId))
            throw new SiteAdminError('SITE_ADMIN_RELATION_BLOCKED', 'Retained revisions still reference this entry.')
        await this.#commit({
            conditions: [this.#guard(entryId, input.expectedVersion), { kind: 'noRetainedRelations', id: entryId }],
            routes: [{ kind: 'remove', entryId }],
            delete: entryId,
            publicGeneration: publicGraphChanged,
        })
        await this.#afterCommit(
            { ...(input.actorId ? { actorId: input.actorId } : {}), entryId, model: entry.model, type: 'delete' },
            publicGraphChanged,
        )
    }

    #id(): string {
        return this.#options.id?.() ?? crypto.randomUUID()
    }

    #date(): Date {
        return this.#options.now?.() ?? new Date()
    }

    #now(): string {
        return this.#date().toISOString()
    }

    async #publishedRows(modelName?: string, ids?: string[], locale?: string): Promise<PublishedRow[]> {
        return this.#storage.published({
            ...(modelName ? { model: modelName } : {}),
            ...(ids ? { ids } : {}),
            ...(locale !== undefined ? { locale } : {}),
        })
    }

    async #publicSnapshot(roots: PublishedRow[]): Promise<Map<string, PublishedRow>> {
        const candidates = new Map<string, PublishedRow>()
        const references = new Map<string, ReturnType<typeof collectReferences>>()
        const assetIds = new Set<string>()
        let frontier = roots.filter((row) => this.#publicModel(row.model))
        while (frontier.length > 0) {
            const nextIds = new Set<string>()
            for (const row of frontier) {
                if (candidates.has(row.id)) continue
                const definition = this.#publicModel(row.model)
                if (!definition) continue
                try {
                    if (row.locale !== this.#locale(definition, row.locale || undefined)) continue
                } catch {
                    continue
                }
                const stored = projectStoredFields(definition.fields, row.data)
                const validated = await validateModelData(definition, stored)
                if (!validated.data || stableJson(validated.data) !== stableJson(stored)) continue
                const found = collectReferences(definition.fields, stored)
                candidates.set(row.id, row)
                references.set(row.id, found)
                for (const reference of found.relations) if (!candidates.has(reference.id)) nextIds.add(reference.id)
                for (const reference of found.assets) assetIds.add(reference.id)
            }
            if (nextIds.size === 0) break
            frontier = await this.#publishedRows(undefined, [...nextIds])
        }
        const readyAssets = new Set<string>()
        if (assetIds.size > 0) {
            const rows = await this.#storage.assets({ state: 'ready', ids: [...assetIds] })

            for (const row of rows) readyAssets.add(row.id)
        }
        let changed = true
        while (changed) {
            changed = false
            for (const [id, found] of references) {
                if (!candidates.has(id)) continue
                const definition = this.#publicModel(candidates.get(id)?.model ?? '')
                const missingAsset = found.assets.some((reference) => !readyAssets.has(reference.id))
                const missingRequiredRelation = found.relations.some((reference) => {
                    const field = definition && fieldAtPath(definition.fields, reference.path)
                    return field?.kind === 'relation' && field.required && !candidates.has(reference.id)
                })
                if (missingAsset || missingRequiredRelation) {
                    candidates.delete(id)
                    changed = true
                }
            }
        }
        return candidates
    }

    async #publicEntryGraph(roots: PublishedRow[]): Promise<Map<string, PublishedRow>> {
        const groups = new Map<string, Set<string>>()
        for (const row of roots) {
            if (!this.#publicModel(row.model)?.localized) continue
            const modelGroups = groups.get(row.model) ?? new Set<string>()
            modelGroups.add(row.translationGroup)
            groups.set(row.model, modelGroups)
        }
        const rows = new Map(roots.map((row) => [row.id, row]))
        for (const [model, translationGroups] of groups) {
            const alternates = await this.#storage.published({ model, translationGroups: [...translationGroups] })
            for (const row of alternates) rows.set(row.id, row)
        }

        return this.#publicSnapshot([...rows.values()])
    }

    #publishedPath(row: PublishedRow): string | null {
        const definition = this.#publicModel(row.model)
        if (!definition) return null
        const redirect = routeRedirect(definition, row.data)
        const basePath =
            this.#options.routing?.enabled === false || (redirect && this.#options.routing?.redirects === false)
                ? null
                : entryPath(row.model, definition, row.slug, this.#apiBases())
        return basePath === null ? null : this.#localizedPath(definition, basePath, row.locale)
    }

    #seoUrl(value: string): string | undefined {
        try {
            const url = new URL(value, this.#options.site?.url ?? 'http://site-admin.local')
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
            return this.#options.site?.url || /^[a-z][a-z\d+.-]*:/iu.test(value) ? url.href : value
        } catch {
            return undefined
        }
    }

    #entryDescription(definition: ModelDefinition, data: Record<string, unknown>): string | undefined {
        for (const key of [definition.displayFields?.description, 'description', 'summary']) {
            if (!key) continue
            const value = data[key]
            const document = markdownDocument(value)
            const description = document
                ? cleanText(astText(document.meta?.summary ?? document.nodes))
                : typeof value === 'string' && definition.fields[key]?.kind !== 'markdown'
                  ? cleanText(value)
                  : ''
            if (description) return description
        }
        return undefined
    }

    #entrySeo(definition: ModelDefinition, entry: PublicEntry): PublicEntrySeo {
        const model = typeof definition.seo === 'function' ? definition.seo(structuredClone(entry)) : definition.seo
        const result = serializeSiteAdminSeo(model)
        const text = (keys: Array<string | undefined>): string | undefined =>
            keys
                .map((key) => (key && typeof entry.data[key] === 'string' ? cleanText(entry.data[key]) : ''))
                .find(Boolean)
        const title = text([definition.displayFields?.title, 'title', 'name'])
        const description = this.#entryDescription(definition, entry.data)
        if (title !== undefined) result.title = title
        if (description !== undefined) result.description = description
        if (entry.path) result.canonical = entry.path
        if (entry.alternates) result.alternates = entry.alternates
        if (result.image !== false && !isObject(result.image)) {
            const imageKeys = [
                definition.displayFields?.image,
                ...Object.entries(definition.fields)
                    .filter(([, field]) => field.kind === 'image' || field.kind === 'images')
                    .map(([name]) => name),
            ]
            for (const key of imageKeys) {
                const value = key ? entry.data[key] : undefined
                const image = Array.isArray(value) ? value[0] : value
                if (isObject(image) && typeof image.url === 'string') {
                    result.image = image.url
                    break
                }
            }
        }
        if (typeof result.image === 'string') {
            const image = this.#seoUrl(result.image)
            if (image === undefined) delete result.image
            else result.image = image
        }
        if (result.canonical !== undefined) {
            const canonical = this.#seoUrl(result.canonical)
            if (canonical === undefined) delete result.canonical
            else result.canonical = canonical
        }
        if (result.alternates)
            result.alternates = result.alternates.flatMap((alternate) => {
                const path = this.#seoUrl(alternate.path)
                return path ? [{ locale: alternate.locale, path }] : []
            })
        return result
    }

    #assetUrl(id: string): string {
        return `${this.#publicBase()}/_assets/${encodeURIComponent(id)}`
    }

    #publicAsset(value: AssetInput): Record<string, unknown> {
        const reference = typeof value === 'string' ? { id: value } : { ...value }
        return {
            ...reference,
            url: this.#assetUrl(reference.id),
        }
    }

    #hydrateField(
        field: AnyField,
        value: unknown,
        graph: Map<string, PublishedRow>,
        trail: Set<string>,
        budget: ProjectionBudget,
        markdownSource: boolean,
    ): unknown {
        if (value === undefined || value === null) return value
        switch (field.kind) {
            case 'relation': {
                if (typeof value !== 'string') return null
                const target = graph.get(value)
                if (!target) return null
                // Related entries remain public projections; markdown-fields only parses this model's schema.
                return this.#projectPublished(target, graph, trail, budget)
            }
            case 'file':
            case 'image':
                return this.#publicAsset(value as AssetInput)
            case 'images':
                return Array.isArray(value) ? value.map((item) => this.#publicAsset(item as AssetInput)) : []
            case 'object':
                return this.#hydrateFields(
                    field.fields,
                    typeof value === 'object' && value !== null && !Array.isArray(value)
                        ? (value as Record<string, unknown>)
                        : {},
                    graph,
                    trail,
                    budget,
                    markdownSource,
                )
            case 'array':
                return Array.isArray(value)
                    ? value.map((item) => this.#hydrateField(field.item, item, graph, trail, budget, markdownSource))
                    : []
            case 'markdown':
                return typeof value === 'string' && !markdownSource
                    ? resolveMarkdownSource(value, (id) => this.#assetUrl(id))
                    : value
            default:
                return value
        }
    }

    #hydrateFields(
        fields: FieldRecord,
        data: Record<string, unknown>,
        graph: Map<string, PublishedRow>,
        trail: Set<string>,
        budget: ProjectionBudget,
        markdownSource: boolean,
    ): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(fields).map(([name, field]) => [
                name,
                this.#hydrateField(field, data[name], graph, trail, budget, markdownSource),
            ]),
        )
    }

    #projectPublished(
        row: PublishedRow,
        graph: Map<string, PublishedRow>,
        parentTrail = new Set<string>(),
        budget: ProjectionBudget = { nodes: 0 },
        markdownSource = false,
    ): PublicEntry {
        if (parentTrail.size > 16 || ++budget.nodes > 10_000)
            throw new SiteAdminError(
                'SITE_ADMIN_RELATION_LIMIT',
                'Public relations exceed depth 16 or 10,000 projected nodes.',
            )
        const definition = this.#publicModel(row.model)
        if (!definition) throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${row.model}" is private.`)
        const path = this.#publishedPath(row)
        if (parentTrail.has(row.id)) {
            return {
                data: {},
                id: row.id,
                locale: row.locale,
                model: row.model,
                path,
                publishedAt: row.publishedAt,
                revisionId: row.revisionId,
                slug: row.slug,
            }
        }
        const trail = new Set(parentTrail).add(row.id)
        const entry: PublicEntry = {
            data: this.#hydrateFields(definition.fields, row.data, graph, trail, budget, markdownSource),
            id: row.id,
            locale: row.locale,
            model: row.model,
            path,
            publishedAt: row.publishedAt,
            revisionId: row.revisionId,
            slug: row.slug,
        }
        if (definition.localized && path) {
            // A transient projection index keeps large localized lists linear, without another content cache.
            if (!budget.alternates) {
                budget.alternates = new Map()
                for (const alternate of graph.values()) {
                    if (!this.#publicModel(alternate.model)?.localized) continue
                    const alternatePath = this.#publishedPath(alternate)
                    if (!alternatePath) continue
                    const key = `${alternate.model}\0${alternate.translationGroup}`
                    const alternates = budget.alternates.get(key) ?? []
                    alternates.push({ locale: alternate.locale, path: alternatePath })
                    budget.alternates.set(key, alternates)
                }
            }
            entry.alternates = (budget.alternates.get(`${row.model}\0${row.translationGroup}`) ?? []).map(
                (alternate) => ({ ...alternate }),
            )
        }
        entry.seo = this.#entrySeo(definition, entry)
        return entry
    }

    async listPublicEntries(modelName: string, locale?: string): Promise<PublicEntry[]> {
        return this.#listPublicEntries(modelName, locale)
    }

    async #listPublicEntries(modelName: string, locale?: string, markdownSource = false): Promise<PublicEntry[]> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false)
            throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const normalizedLocale = this.#locale(definition, locale)
        const rows = await this.#publishedRows(modelName, undefined, normalizedLocale)
        const graph = await this.#publicEntryGraph(rows)
        const budget = { nodes: 0 }
        return rows
            .filter((row) => graph.has(row.id))
            .map((row) => this.#projectPublished(row, graph, new Set(), budget, markdownSource))
    }

    async getPublicEntry(modelName: string, slugOrId: string, locale?: string): Promise<PublicEntry | null> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false)
            throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const normalizedLocale = this.#locale(definition, locale)
        const row = (await this.#storage.published({ model: modelName, locale: normalizedLocale, key: slugOrId }))[0]

        if (!row) return null
        const graph = await this.#publicEntryGraph([row])
        return graph.has(row.id) ? this.#projectPublished(row, graph) : null
    }

    async publicGeneration(): Promise<number> {
        await this.initialize()
        return this.#storage.publicGeneration()
    }

    async content(modelName: string, locale?: string): Promise<ComarkContent> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false)
            throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const normalizedLocale = this.#locale(definition, locale)
        const generation = await this.publicGeneration()
        const cacheKey = `${modelName}\0${normalizedLocale}`
        const cached = this.#content.get(cacheKey)
        if (cached?.generation === generation) return cached.content
        const entries = await this.#listPublicEntries(modelName, normalizedLocale, true)
        const content = createMarkdownContent(
            modelName,
            definition,
            entries,
            this.config.markdown,
            (id) => this.#assetUrl(id),
            (id) => {
                const parsed = this.#parsedContent.get(id)
                return parsed?.generation === generation ? structuredClone(parsed.file) : undefined
            },
        )
        this.#prepareContent(content, definition, generation)
        this.#content.set(cacheKey, { content, generation })
        if (this.#content.size > 64) this.#content.delete(this.#content.keys().next().value!)
        return content
    }

    #prepareContent(content: ComarkContent, definition: ModelDefinition, generation: number): void {
        content.hooks.hook('file:parsed', ({ file }) => {
            if (!file) return
            const metadata = file.data['_siteAdmin']
            const description = this.#entryDescription(definition, file.data)
            if (isObject(metadata) && description !== undefined)
                metadata.seo = { ...serializeSiteAdminSeo(metadata.seo), description }
            if (isObject(metadata) && typeof metadata.id === 'string') {
                this.#parsedContent.set(metadata.id, { file: structuredClone(file), generation })
                if (this.#parsedContent.size > 256) this.#parsedContent.delete(this.#parsedContent.keys().next().value!)
            }
        })
    }

    async resolvePath(
        path: string,
        locale?: string,
    ): Promise<{ entry: PublicEntry; kind: 'page' } | { kind: 'redirect'; status: number; target: string } | null> {
        await this.initialize()
        const normalizedLocale = locale || this.#options.locales?.defaultLocale || ''
        if (
            normalizedLocale &&
            this.#options.locales?.supported &&
            !this.#options.locales.supported.includes(normalizedLocale)
        )
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Unsupported route locale.')
        const generation = await this.publicGeneration()
        const cached = this.#routes.get(normalizedLocale)
        if (cached?.generation !== generation) {
            const router = createRouter<RouteRow>()
            const routes = (await this.#storage.routes({ locales: [normalizedLocale, ''] })).sort(
                (left, right) => Number(left.locale === '') - Number(right.locale === ''),
            )

            for (const route of routes) addRoute(router, 'GET', route.path, route)
            this.#routes.set(normalizedLocale, { generation, router })
            if (this.#routes.size > 64) this.#routes.delete(this.#routes.keys().next().value!)
        }
        const normalizedPath = new URL(path, 'http://site-admin.local').pathname
        const match = findRoute(this.#routes.get(normalizedLocale)!.router, 'GET', normalizedPath, { normalize: true })
        if (!match) return null
        const route = match.data
        const rows = await this.#publishedRows(undefined, [route.entryId])
        const entry = rows[0]
        if (!entry) return null
        const graph = await this.#publicEntryGraph([entry])
        if (!graph.has(entry.id)) return null
        if (route.kind === 'page') {
            const budget = { nodes: 0 }
            const projected = this.#projectPublished(entry, graph, new Set(), budget)
            const definition = this.#model(entry.model)
            let parsed = this.#parsedContent.get(entry.id)
            if (parsed?.generation !== generation) {
                // Parse the already-projected route entry; no second database fetch.
                const content = createMarkdownContent(
                    entry.model,
                    definition,
                    [this.#projectPublished(entry, graph, new Set(), { nodes: 0 }, true)],
                    this.config.markdown,
                    (id) => this.#assetUrl(id),
                )
                this.#prepareContent(content, definition, generation)
                await content.get(`${entry.slug}.json`)
                parsed = this.#parsedContent.get(entry.id)
            }
            const metadata = parsed?.file.data['_siteAdmin']
            if (isObject(metadata)) projected.seo = serializeSiteAdminSeo(metadata.seo)
            // Keep the existing route DTO's self alternate for nonlocalized entries.
            projected.alternates ??= projected.path ? [{ locale: projected.locale, path: projected.path }] : []
            return { entry: projected, kind: 'page' }
        }
        if (!route.targetPath) return null
        return { kind: 'redirect', status: route.status ?? 302, target: route.targetPath }
    }

    async sitemap(): Promise<Array<{ loc: string; lastmod?: string }>> {
        await this.initialize()
        const routes = (await this.#storage.routes({ kinds: ['page'] })).sort((left, right) =>
            left.path.localeCompare(right.path),
        )

        const rows = await this.#publishedRows(undefined, [...new Set(routes.map((route) => route.entryId))])
        const graph = await this.#publicSnapshot(rows)
        const byId = new Map(rows.map((row) => [row.id, row]))
        return routes.flatMap((route) => {
            const row = byId.get(route.entryId)
            const definition = row && this.#publicModel(row.model)
            const options = definition ? modelRouteOptions(definition) : null
            return row &&
                graph.has(row.id) &&
                (this.#resolveRouteRule(route.path).sitemap ?? options?.sitemap) !== false
                ? [{ lastmod: row.publishedAt, loc: decodeURI(route.path) }]
                : []
        })
    }

    async routeSnapshot(): Promise<
        Array<{
            entryId: string
            kind: RouteRow['kind']
            locale: string
            path: string
            status: number | null
            targetPath: string | null
        }>
    > {
        await this.initialize()
        return (await this.#storage.routes()).map(({ entryId, kind, locale, path, status, targetPath }) => ({
            entryId,
            kind,
            locale,
            path,
            status,
            targetPath,
        }))
    }

    async inspect(): Promise<SiteAdminInspection> {
        await this.initialize()
        const stats = await this.#storage.statistics()
        return {
            assets: Object.fromEntries(stats.assets.map(({ state, count }) => [state, count])),
            diagnostics: structuredClone(this.diagnostics),
            entries: Object.fromEntries(stats.entries.map(({ model, ...counts }) => [model, counts])),
            orphanAssets: stats.orphanAssets,
            publicGeneration: await this.publicGeneration(),
        }
    }

    async llmsEntries(): Promise<LLMSEntry[]> {
        await this.initialize()
        const entries: LLMSEntry[] = []
        for (const [modelName, definition] of Object.entries(this.config.models)) {
            if (definition.public === false || !definition.route) continue
            const route = modelRouteOptions(definition)
            if (route?.redirect) continue
            const locales = definition.localized
                ? (this.#options.locales?.supported ?? [this.#locale(definition)])
                : ['']
            for (const locale of locales) {
                const items = await (await this.content(modelName, locale)).list()
                for (const item of items) {
                    if (!isObject(item.data)) continue
                    const metadata = item.data['_siteAdmin']
                    if (!isObject(metadata)) continue
                    const path = metadata.path
                    if (typeof path !== 'string') continue
                    if ((this.#resolveRouteRule(path).llms ?? route?.llms) === false) continue
                    const titleKeys = [definition.displayFields?.title, 'title', 'name']
                    const title =
                        titleKeys
                            .map((key) => (key && typeof item.data[key] === 'string' ? cleanText(item.data[key]) : ''))
                            .find(Boolean) || String(metadata.id ?? path)
                    const documents: MarkdownDocumentValue[] = []
                    for (const [name, field] of Object.entries(definition.fields)) {
                        collectMarkdown(field, item.data[name], documents)
                    }
                    const descriptionValue = definition.displayFields?.description
                        ? item.data[definition.displayFields.description]
                        : undefined
                    const descriptionDocument = markdownDocument(descriptionValue) ?? documents[0]
                    const description = cleanText(astText(descriptionDocument?.meta?.summary))
                    let href = path
                    if (this.#options.site?.url) {
                        try {
                            href = new URL(path, this.#options.site.url).href
                        } catch {}
                    }
                    const content = cleanText(documents.map((document) => astText(document.nodes)).join(' '))
                    entries.push({
                        ...(content ? { content } : {}),
                        ...(description ? { description: description.slice(0, 240) } : {}),
                        href,
                        title,
                    })
                }
            }
        }
        return entries
    }

    async llms(full = false): Promise<string> {
        const lines = [`# ${this.#options.site?.name ?? 'Site content'}`, '', '> Published runtime content.']
        for (const entry of await this.llmsEntries()) {
            lines.push('', `- [${entry.title}](${entry.href})${entry.description ? ` — ${entry.description}` : ''}`)
            if (full && entry.content) lines.push('', `## ${entry.title}`, '', entry.content)
        }
        return `${lines.join('\n')}\n`
    }

    async uploadAsset(input: UploadAssetInput): Promise<AssetRecord> {
        await this.initialize()
        const assets = this.config.assets
        if (!assets || !this.#options.getFiles) {
            throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        }
        const storage = assets.separateDrafts === true ? 'draft' : assets.storage!
        const files = await this.#options.getFiles(storage)
        const upload = await prepareUpload(input, assets.maxUploadSize)
        const id = this.#id()
        const key = `site-admin/${id}/${safeFilename(input.filename)}`
        const contentType = detectedMime(upload.prefix)
        const time = this.#now()
        const token = this.#id()
        const lease = this.#leaseExpiresAt()
        const abort = new AbortController()
        let pumping: Promise<void> | undefined
        try {
            await this.#storage.insertAsset({
                id,
                storage,
                key,
                contentType,
                size: upload.size,
                checksum: null,
                metadata: input.metadata ?? {},
                state: 'uploading',
                operationToken: token,
                leaseExpiresAt: lease,
                createdAt: time,
                updatedAt: time,
            })

            // R2 needs a known-length stream, preserved by the Workers native transform.
            const FixedLength = (
                globalThis as typeof globalThis & {
                    FixedLengthStream?: new (size: number) => TransformStream<Uint8Array, Uint8Array>
                }
            ).FixedLengthStream
            let body = upload.stream
            if (FixedLength) {
                const fixed = new FixedLength(upload.size)
                pumping = upload.stream.pipeTo(fixed.writable, { signal: abort.signal })
                void pumping.catch(() => {})
                body = fixed.readable
            }
            const result = await files.upload(key, body, { contentType })
            await pumping
            const hash = upload.checksum()
            if (Number(result.size) !== upload.size)
                throw new Error('Stored upload size does not match the request body.')
            this.#assertStorageChange(
                await this.#storage.finishAssetUpload(
                    id,
                    token,
                    { contentType, size: result.size, checksum: hash },
                    this.#now(),
                ),
            )
        } catch (error) {
            abort.abort(error)
            await upload.cancel(error).catch(() => {})
            await pumping?.catch(() => {})
            try {
                if (await files.exists(key)) await files.delete(key)
            } catch {}
            await this.#storage.finishAssetUpload(id, token, undefined, this.#now())

            throw error
        }
        return this.getAsset(id)
    }

    async getAsset(id: string): Promise<AssetRecord> {
        await this.initialize()
        const row = await this.#storage.readAsset(id)
        if (!row) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', `Asset "${id}" does not exist.`)
        return row
    }

    async downloadAsset(id: string, publicOnly = true): Promise<DownloadedAsset> {
        await this.initialize()
        const asset = await this.getAsset(id)
        if (asset.state !== 'ready') {
            throw new SiteAdminError('SITE_ADMIN_ASSET_NOT_READY', `Asset "${id}" is not ready.`)
        }
        if (publicOnly) {
            const rows = await this.#publishedRows(undefined, await this.#storage.publishedAssetSources(id))

            const graph = await this.#publicSnapshot(rows)
            if (!rows.some((row) => graph.has(row.id))) {
                throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Asset "${id}" is not public.`)
            }
        }
        if (!this.#options.getFiles) {
            throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        }
        if (publicOnly && this.config.assets?.separateDrafts === true) {
            const copy = (await this.#assetCopies()).find(
                ({ copy: record }) => record.assetId === id && record.state === 'ready',
            )?.copy
            if (!copy) throw new SiteAdminError('SITE_ADMIN_ASSET_NOT_READY', 'The public Asset copy needs retry.')
            const files = await this.#options.getFiles(copy.storage)
            return { asset, file: await files.download(copy.key, { as: 'stream' }) }
        }
        const files = await this.#options.getFiles(asset.storage)
        return { asset, file: await files.download(asset.key, { as: 'stream' }) }
    }

    async deleteAsset(id: string): Promise<void> {
        await this.initialize()
        const asset = await this.getAsset(id)
        if (await this.#storage.hasAssetReferences(id))
            throw new SiteAdminError('SITE_ADMIN_ASSET_IN_USE', 'A retained revision still uses this Asset.')

        const sync = await this.#syncAssetCopies()
        if (sync.failed.length)
            throw new SiteAdminError(
                'SITE_ADMIN_STORAGE_UNAVAILABLE',
                'Retry Asset copy cleanup before deleting its original.',
            )
        const token = await this.#claimAsset(id)
        await this.#deleteClaimedAsset(asset, token)
    }

    async #claimAsset(id: string): Promise<string> {
        const token = this.#id()
        const now = this.#now()
        this.#assertStorageChange(await this.#storage.claimAssetDeletion(id, token, this.#leaseExpiresAt(), now))

        return token
    }

    async #deleteClaimedAsset(asset: AssetRecord, token: string): Promise<void> {
        try {
            if (!this.#options.getFiles) {
                throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
            }
            const files = await this.#options.getFiles(asset.storage)
            if (await files.exists(asset.key)) await files.delete(asset.key)
            this.#assertStorageChange(await this.#storage.finishAssetDeletion(asset.id, token, true, this.#now()))
        } catch (error) {
            await this.#storage.finishAssetDeletion(asset.id, token, false, this.#now())

            throw error
        }
    }

    async runAssetGC(): Promise<{ deleted: string[]; failed: Array<{ id: string; message: string }> }> {
        await this.initialize()
        if (!this.config.assets) return { deleted: [], failed: [] }
        const sync = await this.#syncAssetCopies()
        if (sync.failed.length) return { deleted: [], failed: sync.failed }
        const grace = durationMilliseconds(this.config.assets.cleanup?.minimumAge ?? 60 * 60 * 24)
        const cutoff = new Date(this.#date().getTime() - grace).toISOString()
        const candidates = await this.#storage.assetGCCandidates(cutoff, this.#now())

        const result: { deleted: string[]; failed: Array<{ id: string; message: string }> } = {
            deleted: [],
            failed: [],
        }
        for (const row of candidates) {
            const asset = row
            try {
                const token = await this.#claimAsset(asset.id)
                await this.#deleteClaimedAsset(asset, token)
                result.deleted.push(asset.id)
            } catch (error) {
                result.failed.push({
                    id: asset.id,
                    message: error instanceof Error ? error.message : 'Asset deletion failed.',
                })
            }
        }
        return result
    }

    async #assetStores(): Promise<{ draft: Files; public: Files }> {
        const assets = this.config.assets
        if (!assets || !assets.storage || assets.storage === 'draft' || !this.#options.getFiles)
            throw new SiteAdminError(
                'SITE_ADMIN_STORAGE_UNAVAILABLE',
                'separateDrafts requires private draft and distinct public storage.',
            )
        try {
            const draft = await this.#options.getFiles('draft')
            const publicFiles = await this.#options.getFiles(assets.storage)
            if (!draft || !publicFiles || draft === publicFiles) throw new Error('Storage must be distinct.')
            const sameBinding =
                draft.adapter.name === 'r2-binding' &&
                publicFiles.adapter.name === 'r2-binding' &&
                draft.raw === publicFiles.raw
            const sameRoot =
                draft.adapter.name === 'fs' &&
                publicFiles.adapter.name === 'fs' &&
                isObject(draft.raw) &&
                isObject(publicFiles.raw) &&
                draft.raw.root === publicFiles.raw.root
            if (draft.adapter === publicFiles.adapter || sameBinding || sameRoot)
                throw new Error('Storage backends must be distinct.')
            return { draft, public: publicFiles }
        } catch {
            throw new SiteAdminError(
                'SITE_ADMIN_STORAGE_UNAVAILABLE',
                'Configure private Files SDK draft storage and distinct public storage.',
            )
        }
    }

    async #assetCopies(): Promise<Array<{ ledger: string; copy: AssetCopy }>> {
        return this.#storage.assetCopies()
    }

    async #desiredAssetCopies(): Promise<Set<string>> {
        const graph = await this.#publicSnapshot(await this.#publishedRows())
        const ids = new Set<string>()
        for (const row of graph.values()) {
            const definition = this.#publicModel(row.model)
            if (definition)
                for (const reference of collectReferences(definition.fields, row.data).assets) ids.add(reference.id)
        }
        return ids
    }

    #assertStorageChange(changed: boolean): void {
        if (!changed)
            throw new SiteAdminError('SITE_ADMIN_CONFLICT', 'The record changed before this mutation committed.')
    }

    async #retireAssetCopy(ledger: string, copy: AssetCopy, guard?: StorageAssetCopyGuard): Promise<void> {
        // Keep tombstones for late storage writes; GC retries deletion.
        this.#assertStorageChange(await this.#storage.updateAssetCopy(ledger, { ...copy, state: 'retired' }, guard))
        if (!this.#options.getFiles)
            throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        const files = await this.#options.getFiles(copy.storage)
        if (await files.exists(copy.key)) await files.delete(copy.key)
    }

    async syncAssetCopies(): Promise<AssetSyncResult> {
        await this.initialize()
        return this.#syncAssetCopies()
    }

    async #syncAssetCopies(): Promise<AssetSyncResult> {
        const result: AssetSyncResult = { copied: [], deleted: [], failed: [] }
        if (this.config.assets?.separateDrafts !== true) return result
        // ponytail: one DB lease serializes copy I/O; use per-Asset leases if publication throughput requires it.
        const lease = { expiresAt: this.#leaseExpiresAt(), id: this.#id() }
        const owner = (): StorageAssetCopyGuard => ({ lease, now: this.#now() })
        const generation = () => this.#storage.publicGeneration()
        try {
            this.#assertStorageChange(await this.#storage.claimAssetSync(lease, this.#now()))
        } catch {
            result.failed.push({
                id: '*',
                message: 'Asset synchronization is busy; retry through publishDue or Asset GC.',
            })
            return result
        }
        try {
            const stores = await this.#assetStores()
            const startGeneration = await generation()
            const desired = await this.#desiredAssetCopies()
            const copies = await this.#assetCopies()
            for (const { ledger, copy } of copies) {
                if (copy.state === 'ready' && desired.has(copy.assetId)) continue
                try {
                    await this.#retireAssetCopy(ledger, copy, owner())
                    result.deleted.push(copy.assetId)
                } catch (error) {
                    result.failed.push({
                        id: copy.assetId,
                        message: error instanceof Error ? error.message : 'Public copy deletion failed.',
                    })
                }
            }
            for (const id of desired) {
                if (copies.some(({ copy }) => copy.assetId === id && copy.state === 'ready')) continue
                const token = this.#id()
                const ledger = `${id}:${token}`
                const copy: AssetCopy = {
                    assetId: id,
                    key: `site-admin/public/${id}/${token}`,
                    state: 'copying',
                    storage: this.config.assets.storage!,
                }
                const guard = owner()
                let recorded = false
                try {
                    this.#assertStorageChange(await this.#storage.createAssetCopy(ledger, copy, guard))
                    recorded = true
                    const asset = (await this.#storage.assets({ ids: [id], storage: 'draft', state: 'ready' }))[0]

                    if (!asset)
                        throw new SiteAdminError('SITE_ADMIN_ASSET_NOT_READY', 'The original Asset is not ready.')
                    const file = await stores.draft.download(asset.key, { as: 'stream' })
                    const upload = await prepareUpload({
                        body: file.stream(),
                        filename: asset.key,
                        size: Number(asset.size),
                    })
                    const abort = new AbortController()
                    let pumping: Promise<void> | undefined
                    try {
                        const FixedLength = (
                            globalThis as typeof globalThis & {
                                FixedLengthStream?: new (size: number) => TransformStream<Uint8Array, Uint8Array>
                            }
                        ).FixedLengthStream
                        let body = upload.stream
                        if (FixedLength) {
                            const fixed = new FixedLength(upload.size)
                            pumping = body.pipeTo(fixed.writable, { signal: abort.signal })
                            void pumping.catch(() => {})
                            body = fixed.readable
                        }
                        const stored = await stores.public.upload(copy.key, body, { contentType: asset.contentType })
                        await pumping
                        if (
                            Number(stored.size) !== upload.size ||
                            (asset.checksum && upload.checksum() !== asset.checksum)
                        )
                            throw new Error('Public copy does not match its original.')
                    } catch (error) {
                        abort.abort(error)
                        await upload.cancel(error).catch(() => {})
                        await pumping?.catch(() => {})
                        throw error
                    }
                    const currentGeneration = await generation()
                    if (!(await this.#desiredAssetCopies()).has(id)) {
                        await this.#retireAssetCopy(ledger, copy)
                        result.deleted.push(id)
                        continue
                    }
                    this.#assertStorageChange(
                        await this.#storage.updateAssetCopy(
                            ledger,
                            { ...copy, state: 'ready' },
                            { ...owner(), generation: currentGeneration },
                        ),
                    )

                    result.copied.push(id)
                } catch (error) {
                    if (recorded) {
                        try {
                            await this.#retireAssetCopy(ledger, copy)
                        } catch {
                            /* The durable tombstone is retried by GC. */
                        }
                    }
                    result.failed.push({ id, message: error instanceof Error ? error.message : 'Public copy failed.' })
                }
            }
            if ((await generation()) !== startGeneration)
                result.failed.push({
                    id: '*',
                    message: 'Publication changed during synchronization; retry through publishDue or Asset GC.',
                })
        } catch (error) {
            result.failed.push({
                id: '*',
                message: error instanceof Error ? error.message : 'Asset synchronization failed.',
            })
        } finally {
            await this.#storage.releaseAssetSync(lease)
        }
        return result
    }

    #publicBase(): string {
        return (this.#options.publicBase ?? '/api/content').replace(/\/$/u, '')
    }

    #leaseExpiresAt(): string {
        const duration = durationMilliseconds(this.config.assets?.operationLeaseSeconds ?? 60 * 15)
        return new Date(this.#date().getTime() + duration).toISOString()
    }

    #apiBases(): string[] {
        return [this.#publicBase(), (this.#options.managementBase ?? '/api/site-admin').replace(/\/$/u, '')]
    }
}

export const createSiteAdmin = <Context = unknown>(options: SiteAdminOptions<Context>): SiteAdmin<Context> =>
    new SiteAdmin(options)
