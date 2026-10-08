import type { ComarkContent } from 'comark-content'
import { createMarkdownContent } from '../markdown/content'
import { resolveMarkdownSource } from '../markdown/assets'
import { astText, cleanText, collectMarkdown, markdownDocument, type MarkdownDocumentValue } from '../markdown/document'
import { addRoute, createRouter, findRoute, type RouterContext } from 'rou3'
import type { SiteAdminStorage } from '../adapter'
import { prepareUpload } from './upload'
import { resolveSiteAdminAssets } from '../assets-config'
import type { Files } from 'files-sdk'

import type {
    ModelDefinition,
    SiteAdminAssetAction,
    SiteAdminLifecycleEvent,
    SiteAdminModelAction,
    SiteAdminSystemAction,
} from '../config'
import type {
    SiteAdminAIDraftProposal,
    SiteAdminAIProposal,
    SiteAdminAIRuntime,
    SiteAdminMetadataInput,
    SiteAdminProofreadInput,
} from '../ai'
import { createSiteAdminDescriptor, type SiteAdminDescriptor } from '../descriptor'
import { SiteAdminError, type SiteAdminIssue } from '../errors'
import { createSiteAdminRouteResolver, serializeSiteAdminSeo, type SiteAdminRouteResolver } from '../seo'
import type { AnyField, AssetInput, FieldRecord } from '../fields'
import {
    applyFieldDefaults,
    collectReferences,
    fieldAtPath,
    validateModelData,
    type IndexedReference,
} from '../validation'
import { queryRow, queryRows, runAtomic, type AtomicStatement } from './database'
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
    RevisionRecord,
    SiteAdminDiagnostic,
    SiteAdminInspection,
    SiteAdminOptions,
    UpdateEntryInput,
    UploadAssetInput,
} from './types'

interface EntryRow {
    created_at: string
    current_revision_id: string
    data: string
    id: string
    locale: string
    model: string
    published_at: string | null
    published_revision_id: string | null
    revision_id: string
    scheduled_at: string | null
    scheduled_revision_id: string | null
    slug: string
    sort_order: number | null
    translation_group: string
    updated_at: string
    version: number
}

interface RevisionRow {
    actor_id: string | null
    created_at: string
    data: string
    entry_id: string
    id: string
    slug: string
}

interface ReferenceTargetRow {
    id: string
    model: string
    published_revision_id: string | null
}

interface AssetRow {
    checksum: string | null
    content_type: string
    created_at: string
    id: string
    key: string
    lease_expires_at: string | null
    metadata: string
    operation_token: string | null
    size: number
    state: AssetRecord['state']
    storage: string
    updated_at: string
}

interface PublishedRow {
    data: string
    id: string
    locale: string
    model: string
    published_at: string
    revision_id: string
    slug: string
    translation_group: string
}

interface RouteRow {
    entry_id: string
    kind: 'historical' | 'page' | 'redirect'
    locale: string
    path: string
    revision_id: string | null
    status: number | null
    target_path: string | null
}

interface IncomingReferenceRow {
    entry_id: string
    field_path: string
    model: string
    revision_id: string
    view: 'current' | 'published'
}

interface LLMSEntry {
    content?: string
    description?: string
    href: string
    title: string
}

interface MetaRow {
    value: string
}

interface ProjectionBudget {
    alternates?: Map<string, Array<{ locale: string; path: string }>>
    nodes: number
}

interface AssetCopy {
    assetId: string
    key: string
    state: 'copying' | 'ready' | 'retired'
    storage: string
}

interface SqlGuard {
    clause: string
    params: Array<number | string>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const parseObject = (value: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', 'Stored revision data is not an object.')
    }
    return parsed as Record<string, unknown>
}

const stableJson = (value: unknown): string =>
    JSON.stringify(value, (_, item: unknown) =>
        isObject(item)
            ? Object.fromEntries(Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)))
            : item,
    )

const toEntry = (row: EntryRow): EntryRecord => ({
    createdAt: row.created_at,
    currentRevisionId: row.current_revision_id,
    data: parseObject(row.data),
    id: row.id,
    locale: row.locale,
    model: row.model,
    publishedAt: row.published_at,
    publishedRevisionId: row.published_revision_id,
    revisionId: row.revision_id,
    scheduledAt: row.scheduled_at,
    scheduledRevisionId: row.scheduled_revision_id,
    slug: row.slug,
    sortOrder: row.sort_order,
    translationGroup: row.translation_group,
    updatedAt: row.updated_at,
    version: Number(row.version),
})

const toRevision = (row: RevisionRow): RevisionRecord => ({
    actorId: row.actor_id,
    createdAt: row.created_at,
    data: parseObject(row.data),
    entryId: row.entry_id,
    id: row.id,
    slug: row.slug,
})

const toAsset = (row: AssetRow): AssetRecord => ({
    checksum: row.checksum,
    contentType: row.content_type,
    createdAt: row.created_at,
    id: row.id,
    key: row.key,
    leaseExpiresAt: row.lease_expires_at,
    metadata: parseObject(row.metadata) as Record<string, string>,
    operationToken: row.operation_token,
    size: Number(row.size),
    state: row.state,
    storage: row.storage,
    updatedAt: row.updated_at,
})

const placeholders = (length: number): string => Array.from({ length }, () => '?').join(', ')

const safeId = (value: string, label: string): string => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `${label} contains unsupported characters.`)
    }
    return value
}

const safeFilename = (value: string): string => {
    const name =
        value
            .split(/[\\/]/u)
            .at(-1)
            ?.replace(/[^A-Za-z0-9._-]+/gu, '-') ?? 'file'
    return name.replace(/^[.-]+/u, '').slice(0, 120) || 'file'
}

const mimeMatches = (value: string, accepted: readonly string[]): boolean =>
    accepted.some((entry) => entry === value || (entry.endsWith('/*') && value.startsWith(entry.slice(0, -1))))

const durationMilliseconds = (value: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isFinite(value * 1000))
        throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Asset durations must be finite non-negative seconds.')
    return value * 1000
}

const detectedMime = (bytes: Uint8Array): string => {
    const starts = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value)
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
    if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
    if (starts(0x52, 0x49, 0x46, 0x46) && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
    if (
        new TextDecoder().decode(bytes.slice(4, 12)) === 'ftypavif' ||
        new TextDecoder().decode(bytes.slice(4, 12)) === 'ftypavis'
    )
        return 'image/avif'
    if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
    return 'application/octet-stream'
}

export class SiteAdmin<Context = unknown> {
    readonly #storage: SiteAdminStorage
    readonly #revisionSource: string
    readonly diagnostics: SiteAdminDiagnostic[] = []
    readonly #options: SiteAdminOptions<Context>
    readonly #descriptor: SiteAdminDescriptor
    readonly #resolveRouteRule: SiteAdminRouteResolver
    readonly #content = new Map<string, { content: ComarkContent; generation: number }>()
    readonly #routes = new Map<string, { generation: number; router: RouterContext<RouteRow> }>()
    #initializer: Promise<void> | undefined

    constructor(options: SiteAdminOptions<Context>) {
        if (options.config.assets)
            options = {
                ...options,
                config: { ...options.config, assets: resolveSiteAdminAssets(options.config.assets, options.config)! },
            }
        if (
            options.database?.dialect !== 'sqlite' ||
            typeof options.database.bind !== 'function' ||
            typeof options.database.query !== 'function' ||
            typeof options.database.atomic !== 'function'
        )
            throw new SiteAdminError('SITE_ADMIN_DATABASE_UNSUPPORTED', 'Provide a Site Admin SQLite storage adapter.')
        this.#storage = options.database.bind(options.config)
        this.#revisionSource = this.#storage.revisionSource
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
        const mode = await queryRow<MetaRow>(
            this.#options.database,
            "SELECT value FROM site_admin_meta WHERE key = 'asset_storage_mode'",
        )
        const assets = this.config.assets
        if (mode && mode.value !== (assets?.separateDrafts === true ? `separate:${assets.storage}` : 'shared'))
            throw new SiteAdminError(
                'SITE_ADMIN_MIGRATION_REQUIRED',
                'Migrate existing Asset copies before changing the storage mode.',
            )
        if (assets?.separateDrafts === true) {
            await this.#assetStores()
            const legacy = await queryRow<{ id: string }>(
                this.#options.database,
                "SELECT id FROM site_admin_assets WHERE storage <> 'draft' AND state <> 'deleted' LIMIT 1",
            )
            if (legacy)
                throw new SiteAdminError(
                    'SITE_ADMIN_MIGRATION_REQUIRED',
                    'Move existing Asset originals to private draft storage before enabling separateDrafts.',
                )
            await this.#commit([
                {
                    sql: "INSERT INTO site_admin_meta(key, value) VALUES ('asset_storage_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE site_admin_meta.value = excluded.value RETURNING value",
                    params: [`separate:${assets.storage}`],
                    query: true,
                    expectRow: true,
                },
            ])
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

    async #entryRow(id: string): Promise<EntryRow | undefined> {
        return queryRow<EntryRow>(
            this.#options.database,
            `SELECT e.*, r.id AS revision_id, r.data, r.slug
             FROM site_admin_entries e
             JOIN ${this.#revisionSource} r ON r.id = e.current_revision_id
             WHERE e.id = ?`,
            [id],
        )
    }

    async #requiredEntry(id: string): Promise<EntryRow> {
        const row = await this.#entryRow(id)
        if (!row) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', `Entry "${id}" does not exist.`)
        return row
    }

    async getEntry(id: string): Promise<EntryRecord> {
        await this.initialize()
        return toEntry(await this.#requiredEntry(id))
    }

    async listEntries(modelName?: string): Promise<EntryRecord[]> {
        await this.initialize()
        if (modelName) this.#model(modelName)
        const rows = await queryRows<EntryRow>(
            this.#options.database,
            `SELECT e.*, r.id AS revision_id, r.data, r.slug
             FROM site_admin_entries e
             JOIN ${this.#revisionSource} r ON r.id = e.current_revision_id
             ${modelName ? 'WHERE e.model = ?' : ''}
             ORDER BY e.sort_order IS NULL, e.sort_order, e.updated_at DESC, e.id`,
            modelName ? [modelName] : [],
        )
        return rows.map(toEntry)
    }

    async listRevisions(entryId: string): Promise<RevisionRecord[]> {
        await this.initialize()
        await this.#requiredEntry(entryId)
        return (
            await queryRows<RevisionRow>(
                this.#options.database,
                `SELECT * FROM ${this.#revisionSource} WHERE entry_id = ? ORDER BY created_at DESC`,
                [entryId],
            )
        ).map(toRevision)
    }

    async runAIAction(
        entryId: string,
        actionName: string,
        input: Record<string, unknown>,
    ): Promise<SiteAdminAIProposal> {
        await this.initialize()
        const entry = await this.getEntry(entryId)
        const action = (this.#options.aiActions?.models ?? this.config.ai?.models)?.[entry.model]?.[actionName]
        if (!action) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', `AI action "${actionName}" does not exist.`)
        const output = await action({ entry, input })
        const definition = this.#model(entry.model)
        const validated = await validateModelData(definition, output.data)
        const issues = [...(output.issues ?? []), ...validated.issues]
        let slug = output.slug ?? entry.slug
        try {
            slug = validateSlug(slug, this.config.modelDefaults?.slug?.maxLength ?? 80)
        } catch (error) {
            issues.push({ message: error instanceof Error ? error.message : 'Invalid slug.', path: 'slug' })
        }
        return {
            baseRevisionId: entry.currentRevisionId,
            data: validated.data ?? output.data,
            issues,
            slug,
            version: entry.version,
        }
    }

    /** Proposes changes to an unsaved draft without reading, saving, or publishing an entry. */
    async generateMetadata(
        modelName: string,
        input: SiteAdminMetadataInput,
        context?: Context,
    ): Promise<SiteAdminAIDraftProposal> {
        const definition = this.#model(modelName)
        if (!isObject(input) || !isObject(input.data))
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"data" must be an object.')
        if (!isObject(input.generate))
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"generate" must be an object.')
        for (const [field, value] of Object.entries(input.generate))
            if (!['slug', 'excerpt'].includes(field) || typeof value !== 'boolean')
                throw new SiteAdminError(
                    'SITE_ADMIN_INVALID_INPUT',
                    '"generate" may contain only boolean slug and excerpt flags.',
                )
        if (input.slug !== undefined && typeof input.slug !== 'string')
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"slug" must be a string.')
        return this.#runDraftAI(context, (runtime) =>
            runtime.generateMetadata(modelName, definition, input, this.config.modelDefaults?.slug?.maxLength ?? 80),
        )
    }

    /** Proposes proofreading edits. The caller must explicitly apply and save the proposal. */
    async proofreadDraft(
        modelName: string,
        input: SiteAdminProofreadInput,
        context?: Context,
    ): Promise<SiteAdminAIDraftProposal> {
        const definition = this.#model(modelName)
        if (!isObject(input) || !isObject(input.data))
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"data" must be an object.')
        if (
            input.fields !== undefined &&
            (!Array.isArray(input.fields) || input.fields.some((field) => typeof field !== 'string'))
        )
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', '"fields" must be an array of strings.')
        return this.#runDraftAI(context, (runtime) => runtime.proofreadDraft(modelName, definition, input))
    }

    async #runDraftAI(
        context: Context | undefined,
        operation: (runtime: SiteAdminAIRuntime) => Promise<SiteAdminAIDraftProposal>,
    ): Promise<SiteAdminAIDraftProposal> {
        if (this.#options.aiEnabled === false || !this.#options.aiRuntime)
            throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'AI operations are not available.')
        try {
            const runtime =
                typeof this.#options.aiRuntime === 'function'
                    ? await this.#options.aiRuntime(context)
                    : this.#options.aiRuntime
            return await operation(runtime)
        } catch (error) {
            if (error instanceof SiteAdminError) {
                if (error.code === 'SITE_ADMIN_INVALID_INPUT') throw error
                if (error.code === 'SITE_ADMIN_AI_UNAVAILABLE')
                    throw new SiteAdminError(error.code, 'AI operations are not available.')
                if (error.code === 'SITE_ADMIN_AI_OUTPUT_INVALID')
                    throw new SiteAdminError(error.code, 'AI returned an invalid response.')
            }
            throw new SiteAdminError('SITE_ADMIN_AI_FAILED', 'AI operation failed.')
        }
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
        const pointer = options.view === 'published' ? 'published_revision_id' : 'current_revision_id'
        const conditions = ['rel.target_entry_id = ?']
        const params = [options.view, entryId]
        if (options.from) {
            conditions.push('source.model = ?')
            params.push(options.from)
        }
        if (options.field) {
            conditions.push('rel.field_path = ?')
            params.push(options.field)
        }
        const rows = await queryRows<IncomingReferenceRow>(
            this.#options.database,
            `SELECT source.id AS entry_id, source.model, rel.revision_id, rel.field_path,
                    ? AS view
             FROM site_admin_relations rel
             JOIN site_admin_entries source ON source.${pointer} = rel.revision_id
             WHERE ${conditions.join(' AND ')} ORDER BY source.model, source.id, rel.field_path`,
            params,
        )
        return rows.map((row) => ({
            entryId: row.entry_id,
            field: row.field_path,
            model: row.model,
            revisionId: row.revision_id,
            view: row.view,
        }))
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
        const guard = this.#combineGuards(
            this.#guard(entryId, input.expectedVersion),
            this.#referenceGuard(definition, prepared, true),
        )
        const statements = this.#revisionStatements({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            assets: prepared.assets,
            data: prepared.data,
            entryId,
            ...(guard ? { guard } : {}),
            model: definition,
            relations: prepared.relations,
            revisionId: restoredRevisionId,
            slug: revision.slug,
            time,
        })
        statements.push({
            expectRow: true,
            params: [restoredRevisionId, time, entryId, input.expectedVersion, ...(guard?.params ?? [])],
            query: true,
            sql: `UPDATE site_admin_entries SET current_revision_id = ?, version = version + 1, updated_at = ?
                  WHERE id = ? AND version = ?${guard ? ` AND ${guard.clause}` : ''} RETURNING version`,
        })
        await this.#commit(statements)
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
        const revisions = await queryRows<{ id: string }>(
            this.#options.database,
            'SELECT id FROM site_admin_revisions WHERE entry_id = ? ORDER BY created_at DESC, id DESC',
            [entryId],
        )
        const candidates = revisions.slice(retain).map((revision) => revision.id)
        if (candidates.length === 0) return { deleted: [] }
        const deletable = (table: string): string => `revision_id IN (${placeholders(candidates.length)})
            AND NOT EXISTS (
                SELECT 1 FROM site_admin_entries protected
                WHERE protected.id = ? AND (
                    protected.current_revision_id = ${table}.revision_id
                    OR protected.published_revision_id = ${table}.revision_id
                    OR protected.scheduled_revision_id = ${table}.revision_id
                )
            ) AND NOT EXISTS (
                SELECT 1 FROM site_admin_routes protected_route
                WHERE protected_route.revision_id = ${table}.revision_id
            )`
        const results = await runAtomic(this.#options.database, [
            {
                params: [...candidates, entryId],
                sql: `DELETE FROM site_admin_asset_refs WHERE ${deletable('site_admin_asset_refs')}`,
            },
            {
                params: [...candidates, entryId],
                sql: `DELETE FROM site_admin_relations WHERE ${deletable('site_admin_relations')}`,
            },
            {
                query: true,
                sql: `DELETE FROM site_admin_revisions AS candidate WHERE entry_id = ?
                      AND id IN (${placeholders(candidates.length)})
                      AND NOT EXISTS (
                          SELECT 1 FROM site_admin_entries protected WHERE protected.id = ? AND (
                              protected.current_revision_id = candidate.id OR protected.published_revision_id = candidate.id
                              OR protected.scheduled_revision_id = candidate.id
                          )
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM site_admin_routes protected_route
                          WHERE protected_route.entry_id = ? AND protected_route.revision_id = candidate.id
                      ) RETURNING id`,
                params: [entryId, ...candidates, entryId, entryId],
            },
        ])
        await this.#requireAssetSync()
        return { deleted: ((results.at(-1)?.rows ?? []) as Array<{ id: string }>).map((row) => row.id) }
    }

    async #revision(id: string, entryId?: string): Promise<RevisionRow> {
        const row = await queryRow<RevisionRow>(
            this.#options.database,
            `SELECT * FROM ${this.#revisionSource} WHERE id = ?${entryId ? ' AND entry_id = ?' : ''}`,
            entryId ? [id, entryId] : [id],
        )
        if (!row) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', `Revision "${id}" does not exist.`)
        return row
    }

    async #resolveSlug(
        modelName: string,
        definition: ModelDefinition,
        data: Record<string, unknown>,
        explicit: string | undefined,
        fallbackId: string,
    ): Promise<string> {
        const maxLength = this.config.modelDefaults?.slug?.maxLength ?? 80
        if (explicit !== undefined) return validateSlug(explicit, maxLength)
        if (this.#options.aiEnabled && this.config.ai?.slug) {
            try {
                const suggestion = await this.config.ai.slug({ data, model: modelName })
                if (suggestion) {
                    const generated = slugify(suggestion, maxLength)
                    if (generated) return generated
                }
            } catch (error) {
                this.diagnostics.push({
                    code: 'SITE_ADMIN_AI_SLUG_FAILED',
                    message: error instanceof Error ? error.message : 'AI slug generation failed.',
                })
            }
        }
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
        const stored = parseObject(revision.data)
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
            const rows = await queryRows<ReferenceTargetRow>(
                this.#options.database,
                `SELECT id, model, published_revision_id FROM site_admin_entries WHERE id IN (${placeholders(relationIds.length)})`,
                relationIds,
            )
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
            const rows = await queryRows<AssetRow>(
                this.#options.database,
                `SELECT * FROM site_admin_assets WHERE id IN (${placeholders(assetIds.length)})`,
                assetIds,
            )
            for (const row of rows) assets.set(row.id, row)
        }
        for (const reference of references.assets) {
            const asset = assets.get(reference.id)
            const field = fieldAtPath(definition.fields, reference.path)
            if (!asset || asset.state !== 'ready') {
                issues.push({ message: `Asset "${reference.id}" is not ready.`, path: reference.path })
            } else if (field && 'accept' in field && field.accept && !mimeMatches(asset.content_type, field.accept)) {
                issues.push({
                    message: `Asset type "${asset.content_type}" is not accepted.`,
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

    #guard(entryId: string, expectedVersion: number): SqlGuard {
        return {
            clause: 'EXISTS (SELECT 1 FROM site_admin_entries WHERE id = ? AND version = ?)',
            params: [entryId, expectedVersion],
        }
    }

    #combineGuards(...guards: Array<SqlGuard | undefined>): SqlGuard | undefined {
        const active = guards.filter((guard): guard is SqlGuard => guard !== undefined)
        if (active.length === 0) return undefined
        return {
            clause: active.map((guard) => `(${guard.clause})`).join(' AND '),
            params: active.flatMap((guard) => guard.params),
        }
    }

    #referenceGuard(
        definition: ModelDefinition,
        references: { assets: IndexedReference[]; relations: IndexedReference[] },
        publishing: boolean,
    ): SqlGuard | undefined {
        const clauses: string[] = []
        const params: Array<number | string> = []
        const assets = new Set(references.assets.map((reference) => reference.id))
        for (const id of assets) {
            clauses.push("EXISTS (SELECT 1 FROM site_admin_assets WHERE id = ? AND state = 'ready')")
            params.push(id)
        }
        const relations = new Map<string, { model: string; published: boolean }>()
        for (const reference of references.relations) {
            const field = fieldAtPath(definition.fields, reference.path)
            if (field?.kind === 'relation') {
                relations.set(`${reference.id}\0${field.model}`, {
                    model: field.model,
                    published: publishing && field.required === true,
                })
            }
        }
        for (const [key, relation] of relations) {
            const id = key.slice(0, key.indexOf('\0'))
            clauses.push(
                `EXISTS (SELECT 1 FROM site_admin_entries WHERE id = ? AND model = ?${relation.published ? ' AND published_revision_id IS NOT NULL' : ''})`,
            )
            params.push(id, relation.model)
        }
        return clauses.length > 0 ? { clause: clauses.join(' AND '), params } : undefined
    }

    #revisionStatements(input: {
        actorId?: string
        assets: IndexedReference[]
        data: Record<string, unknown>
        entryId: string
        guard?: SqlGuard
        model: ModelDefinition
        revisionId: string
        slug: string
        time: string
        relations: IndexedReference[]
    }): AtomicStatement[] {
        const guard = input.guard
        const values = [input.revisionId, input.entryId, input.slug, input.actorId ?? null, input.time]
        const statements: AtomicStatement[] = [
            guard
                ? {
                      sql: `INSERT INTO site_admin_revisions(id, entry_id, slug, actor_id, created_at)
                            SELECT ?, ?, ?, ?, ? WHERE ${guard.clause}`,
                      params: [...values, ...guard.params],
                  }
                : {
                      sql: `INSERT INTO site_admin_revisions(id, entry_id, slug, actor_id, created_at)
                            VALUES (?, ?, ?, ?, ?)`,
                      params: values,
                  },
        ]
        const modelName = Object.entries(this.config.models).find(([, definition]) => definition === input.model)?.[0]
        if (!modelName) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Unknown content Model.')
        statements.push(this.#storage.insertRevisionData(modelName, input.revisionId, input.data))
        for (const reference of input.relations) {
            const field = fieldAtPath(input.model.fields, reference.path)
            const params = [
                input.revisionId,
                reference.path,
                reference.id,
                reference.position,
                field?.kind === 'relation' && field.required ? 1 : 0,
            ]
            statements.push(
                guard
                    ? {
                          sql: `INSERT INTO site_admin_relations(revision_id, field_path, target_entry_id, position, required)
                                SELECT ?, ?, ?, ?, ? WHERE ${guard.clause}`,
                          params: [...params, ...guard.params],
                      }
                    : {
                          sql: `INSERT INTO site_admin_relations(revision_id, field_path, target_entry_id, position, required)
                                VALUES (?, ?, ?, ?, ?)`,
                          params,
                      },
            )
        }
        for (const reference of input.assets) {
            const params = [input.revisionId, reference.path, reference.id, reference.position]
            statements.push(
                guard
                    ? {
                          sql: `INSERT INTO site_admin_asset_refs(revision_id, field_path, asset_id, position)
                                SELECT ?, ?, ?, ? WHERE ${guard.clause}`,
                          params: [...params, ...guard.params],
                      }
                    : {
                          sql: `INSERT INTO site_admin_asset_refs(revision_id, field_path, asset_id, position)
                                VALUES (?, ?, ?, ?)`,
                          params,
                      },
            )
        }
        return statements
    }

    async #currentRoute(entryId: string): Promise<RouteRow | undefined> {
        return queryRow<RouteRow>(
            this.#options.database,
            "SELECT * FROM site_admin_routes WHERE entry_id = ? AND kind IN ('page', 'redirect') LIMIT 1",
            [entryId],
        )
    }

    async #routeStatements(input: {
        data: Record<string, unknown>
        definition: ModelDefinition
        entryId: string
        guard?: SqlGuard
        modelName: string
        locale: string
        revisionId: string
        slug: string
        time: string
    }): Promise<AtomicStatement[]> {
        const redirect = routeRedirect(input.definition, input.data)
        const current = await this.#currentRoute(input.entryId)
        const basePath =
            this.#options.routing?.enabled === false || (redirect && this.#options.routing?.redirects === false)
                ? null
                : input.definition.public === false
                  ? null
                  : entryPath(input.modelName, input.definition, input.slug, this.#apiBases())
        const path = basePath === null ? null : this.#localizedPath(input.definition, basePath, input.locale)
        const guard = input.guard
        const guardedDelete = (sql: string, params: Array<string | number>): AtomicStatement =>
            guard ? { sql: `${sql} AND ${guard.clause}`, params: [...params, ...guard.params] } : { sql, params }
        const statements: AtomicStatement[] = []
        if (guard) {
            statements.push({
                sql: `UPDATE site_admin_routes SET target_path = ?, status = ?
                      WHERE entry_id = ? AND kind = 'historical' AND ${guard.clause}`,
                params: [
                    path,
                    this.config.modelDefaults?.historicalRedirectStatus ?? 301,
                    input.entryId,
                    ...guard.params,
                ],
            })
        } else {
            statements.push({
                sql: "UPDATE site_admin_routes SET target_path = ?, status = ? WHERE entry_id = ? AND kind = 'historical'",
                params: [path, this.config.modelDefaults?.historicalRedirectStatus ?? 301, input.entryId],
            })
        }
        statements.push(
            guardedDelete("DELETE FROM site_admin_routes WHERE entry_id = ? AND kind IN ('page', 'redirect')", [
                input.entryId,
            ]),
        )
        if (!path) return statements
        statements.push(
            guardedDelete('DELETE FROM site_admin_routes WHERE entry_id = ? AND path = ?', [input.entryId, path]),
        )
        if (current && current.path !== path && this.#options.routing?.preserveHistory !== false) {
            const values = [
                current.path,
                current.locale,
                input.entryId,
                input.revisionId,
                'historical',
                path,
                this.config.modelDefaults?.historicalRedirectStatus ?? 301,
                input.time,
            ]
            statements.push(
                guard
                    ? {
                          sql: `INSERT INTO site_admin_routes(path, locale, entry_id, revision_id, kind, target_path, status, created_at)
                                SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.clause}`,
                          params: [...values, ...guard.params],
                      }
                    : {
                          sql: `INSERT INTO site_admin_routes(path, locale, entry_id, revision_id, kind, target_path, status, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                          params: values,
                      },
            )
        }
        const values = [
            path,
            input.locale,
            input.entryId,
            input.revisionId,
            redirect ? 'redirect' : 'page',
            redirect?.target ?? null,
            redirect?.status ?? null,
            input.time,
        ]
        statements.push(
            guard
                ? {
                      sql: `INSERT INTO site_admin_routes(path, locale, entry_id, revision_id, kind, target_path, status, created_at)
                            SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.clause}`,
                      params: [...values, ...guard.params],
                  }
                : {
                      sql: `INSERT INTO site_admin_routes(path, locale, entry_id, revision_id, kind, target_path, status, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                      params: values,
                  },
        )
        return statements
    }

    async #reconcileRoutes(): Promise<void> {
        const routes = await queryRows<RouteRow>(this.#options.database, 'SELECT * FROM site_admin_routes')
        const rows = await this.#publishedRows()
        const graph = await this.#publicSnapshot(rows)
        const routesByEntry = new Map<string, RouteRow[]>()
        for (const route of routes) {
            const list = routesByEntry.get(route.entry_id) ?? []
            list.push(route)
            routesByEntry.set(route.entry_id, list)
        }
        const statements: AtomicStatement[] = []
        for (const entryId of routesByEntry.keys()) {
            const row = graph.get(entryId)
            const definition = row && this.#publicModel(row.model)
            if (!row || !definition?.route || this.#options.routing?.enabled === false) {
                statements.push({ sql: 'DELETE FROM site_admin_routes WHERE entry_id = ?', params: [entryId] })
                routesByEntry.delete(entryId)
            }
        }
        const time = this.#now()
        for (const row of rows) {
            if (!graph.has(row.id)) continue
            const definition = this.#publicModel(row.model)
            if (!definition?.route || this.#options.routing?.enabled === false) continue
            const data = parseObject(row.data)
            const redirect = routeRedirect(definition, data)
            if (redirect && this.#options.routing?.redirects === false) {
                if (routesByEntry.has(row.id)) {
                    statements.push({ sql: 'DELETE FROM site_admin_routes WHERE entry_id = ?', params: [row.id] })
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
                current.revision_id === row.revision_id &&
                current.kind === (redirect ? 'redirect' : 'page') &&
                current.target_path === (redirect?.target ?? null) &&
                current.status === (redirect?.status ?? null)
            )
                continue
            statements.push(
                ...(await this.#routeStatements({
                    data,
                    definition,
                    entryId: row.id,
                    locale: row.locale,
                    modelName: row.model,
                    revisionId: row.revision_id,
                    slug: row.slug,
                    time,
                })),
            )
        }
        if (statements.length > 0) await this.#commit([...statements, this.#generationStatement()])
    }

    #generationStatement(guard?: SqlGuard): AtomicStatement {
        if (guard) {
            return {
                sql: `INSERT INTO site_admin_meta(key,value) SELECT 'public_generation','1' WHERE ${guard.clause}
                      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
                params: guard.params,
            }
        }
        return {
            sql: "INSERT INTO site_admin_meta(key,value) VALUES ('public_generation','1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
        }
    }

    async #commit(statements: AtomicStatement[]): Promise<void> {
        await runAtomic(this.#options.database, statements)
    }

    async #afterCommit(event: SiteAdminLifecycleEvent): Promise<void> {
        const result = await this.#syncAssetCopies()
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

    async #requireAssetSync(): Promise<void> {
        this.#assertAssetSync(await this.#syncAssetCopies())
    }

    async createEntry(modelName: string, input: EntryInput): Promise<EntryRecord> {
        await this.initialize()
        const definition = this.#model(modelName)
        const locale = this.#locale(definition, input.locale)
        const id = safeId(input.id ?? this.#id(), 'Entry ID')
        const prepared = await this.#prepareData(definition, input.data, true)
        const slug = await this.#resolveSlug(modelName, definition, prepared.data, input.slug, id)
        const revisionId = this.#id()
        const time = this.#now()
        const published = definition.publishing === false
        const guard = this.#referenceGuard(definition, prepared, published)
        const statements: AtomicStatement[] = [
            guard
                ? {
                      sql: `INSERT INTO site_admin_entries(
                    id, model, locale, translation_group, sort_order, version, created_at, updated_at, published_at
                ) SELECT ?, ?, ?, ?, ?, 0, ?, ?, ? WHERE ${guard.clause}`,
                      params: [
                          id,
                          modelName,
                          locale,
                          input.translationGroup ?? id,
                          input.sortOrder ?? null,
                          time,
                          time,
                          published ? time : null,
                          ...guard.params,
                      ],
                  }
                : {
                      sql: `INSERT INTO site_admin_entries(
                    id, model, locale, translation_group, sort_order, version, created_at, updated_at, published_at
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
                      params: [
                          id,
                          modelName,
                          locale,
                          input.translationGroup ?? id,
                          input.sortOrder ?? null,
                          time,
                          time,
                          published ? time : null,
                      ],
                  },
            ...this.#revisionStatements({
                ...(input.actorId ? { actorId: input.actorId } : {}),
                assets: prepared.assets,
                data: prepared.data,
                entryId: id,
                ...(guard ? { guard } : {}),
                model: definition,
                revisionId,
                slug,
                time,
                relations: prepared.relations,
            }),
        ]
        if (published) {
            await this.#assertPublishableRelations(definition, prepared.relations, id)
            statements.push(
                ...(await this.#routeStatements({
                    data: prepared.data,
                    definition,
                    entryId: id,
                    ...(guard ? { guard } : {}),
                    modelName,
                    locale,
                    revisionId,
                    slug,
                    time,
                })),
                this.#generationStatement(guard),
            )
        }
        statements.push({
            expectRow: true,
            params: [revisionId, published ? revisionId : null, time, id, ...(guard?.params ?? [])],
            query: true,
            sql: `UPDATE site_admin_entries
                  SET current_revision_id = ?, published_revision_id = ?, version = 1, updated_at = ?
                  WHERE id = ? AND version = 0${guard ? ` AND ${guard.clause}` : ''} RETURNING version`,
        })
        await this.#commit(statements)
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId: id,
            model: modelName,
            revisionId,
            type: 'create',
        })
        return this.getEntry(id)
    }

    async updateEntry(entryId: string, input: UpdateEntryInput): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const definition = this.#model(entry.model)
        const prepared = await this.#prepareData(definition, input.data, false)
        const slug =
            input.slug === undefined
                ? entry.slug
                : await this.#resolveSlug(entry.model, definition, prepared.data, input.slug, entry.id)
        const revisionId = this.#id()
        const time = this.#now()
        const published = definition.publishing === false
        const guard = this.#combineGuards(
            this.#guard(entryId, input.expectedVersion),
            this.#referenceGuard(definition, prepared, published),
        )
        const statements = this.#revisionStatements({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            assets: prepared.assets,
            data: prepared.data,
            entryId,
            ...(guard ? { guard } : {}),
            model: definition,
            revisionId,
            slug,
            time,
            relations: prepared.relations,
        })
        if (published) {
            await this.#assertPublishableRelations(definition, prepared.relations, entryId)
            statements.push(
                ...(await this.#routeStatements({
                    data: prepared.data,
                    definition,
                    entryId,
                    ...(guard ? { guard } : {}),
                    modelName: entry.model,
                    locale: entry.locale,
                    revisionId,
                    slug,
                    time,
                })),
                this.#generationStatement(guard),
            )
        }
        statements.push({
            expectRow: true,
            params: [
                revisionId,
                ...(published ? [revisionId] : []),
                ...(published ? [time] : []),
                time,
                entryId,
                input.expectedVersion,
                ...(guard?.params ?? []),
            ],
            query: true,
            sql: `UPDATE site_admin_entries SET current_revision_id = ?${published ? ', published_revision_id = ?' : ''},
                  ${published ? 'published_at = ?,' : ''} version = version + 1, updated_at = ?
                  WHERE id = ? AND version = ?${guard ? ` AND ${guard.clause}` : ''} RETURNING version`,
        })
        await this.#commit(statements)
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            revisionId,
            type: 'update',
        })
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

    async publishEntry(
        entryId: string,
        input: { actorId?: string; expectedVersion: number; revisionId?: string },
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const definition = this.#model(entry.model)
        const revision = await this.#revision(input.revisionId ?? entry.current_revision_id, entryId)
        const prepared = await this.#prepareRevision(definition, revision)
        await this.#assertPublishableRelations(definition, prepared.relations, entryId)
        const time = this.#now()
        const guard = this.#combineGuards(
            this.#guard(entryId, input.expectedVersion),
            this.#referenceGuard(definition, prepared, true),
        )
        const statements: AtomicStatement[] = [
            ...(await this.#routeStatements({
                data: prepared.data,
                definition,
                entryId,
                ...(guard ? { guard } : {}),
                modelName: entry.model,
                locale: entry.locale,
                revisionId: revision.id,
                slug: revision.slug,
                time,
            })),
            this.#generationStatement(guard),
            {
                expectRow: true,
                params: [revision.id, time, time, entryId, input.expectedVersion, ...(guard?.params ?? [])],
                query: true,
                sql: `UPDATE site_admin_entries
                      SET published_revision_id = ?, published_at = ?, scheduled_revision_id = NULL, scheduled_at = NULL,
                          version = version + 1, updated_at = ?
                      WHERE id = ? AND version = ?${guard ? ` AND ${guard.clause}` : ''} RETURNING version`,
            },
        ]
        await this.#commit(statements)
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            revisionId: revision.id,
            type: 'publish',
        })
        return this.getEntry(entryId)
    }

    async #assertCanUnpublish(entryId: string): Promise<void> {
        const incoming = await queryRows<IncomingReferenceRow>(
            this.#options.database,
            `SELECT rel.field_path, source.model, rel.revision_id
             FROM site_admin_relations rel
             JOIN site_admin_entries source ON source.published_revision_id = rel.revision_id
             WHERE rel.target_entry_id = ? AND source.id <> ? AND rel.required = 1`,
            [entryId, entryId],
        )
        const blocking = incoming.filter((reference) => this.#publicModel(reference.model))
        if (blocking.length > 0) {
            throw new SiteAdminError(
                'SITE_ADMIN_RELATION_BLOCKED',
                'Published entries contain required relations to this entry.',
                blocking.map((reference) => ({
                    message: 'Required published relation would be broken.',
                    path: reference.field_path,
                })),
            )
        }
    }

    #unpublishGuard(entryId: string): SqlGuard {
        const publicModels = Object.entries(this.config.models)
            .filter(([, definition]) => definition.public !== false)
            .map(([name]) => name)
        if (publicModels.length === 0) return { clause: '1 = 1', params: [] }
        return {
            clause: `NOT EXISTS (
                SELECT 1 FROM site_admin_relations rel
                JOIN site_admin_entries source ON source.published_revision_id = rel.revision_id
                WHERE rel.target_entry_id = ? AND source.id <> ? AND rel.required = 1
                  AND source.model IN (${placeholders(publicModels.length)})
            )`,
            params: [entryId, entryId, ...publicModels],
        }
    }

    async unpublishEntry(entryId: string, input: { actorId?: string; expectedVersion: number }): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        await this.#assertCanUnpublish(entryId)
        const guard = this.#combineGuards(this.#guard(entryId, input.expectedVersion), this.#unpublishGuard(entryId))
        if (!guard) throw new SiteAdminError('SITE_ADMIN_CONFLICT', 'Unable to guard unpublish operation.')
        const time = this.#now()
        await this.#commit([
            {
                params: [entryId, ...guard.params],
                sql: `DELETE FROM site_admin_routes WHERE entry_id = ? AND ${guard.clause}`,
            },
            this.#generationStatement(guard),
            {
                expectRow: true,
                params: [time, entryId, input.expectedVersion, ...guard.params],
                query: true,
                sql: `UPDATE site_admin_entries
                      SET published_revision_id = NULL, scheduled_revision_id = NULL, scheduled_at = NULL,
                          published_at = NULL, version = version + 1, updated_at = ?
                      WHERE id = ? AND version = ? AND ${guard.clause} RETURNING version`,
            },
        ])
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            type: 'unpublish',
        })
        return this.getEntry(entryId)
    }

    async schedulePublish(
        entryId: string,
        input: { actorId?: string; at: Date | string; expectedVersion: number; revisionId?: string },
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const revision = await this.#revision(input.revisionId ?? entry.current_revision_id, entryId)
        const at = input.at instanceof Date ? input.at : new Date(input.at)
        if (!Number.isFinite(at.getTime()) || at.getTime() <= this.#date().getTime()) {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Scheduled publish time must be in the future.')
        }
        const time = this.#now()
        await this.#commit([
            {
                expectRow: true,
                params: [revision.id, at.toISOString(), time, entryId, input.expectedVersion],
                query: true,
                sql: `UPDATE site_admin_entries
                      SET scheduled_revision_id = ?, scheduled_at = ?, version = version + 1, updated_at = ?
                      WHERE id = ? AND version = ? RETURNING version`,
            },
        ])
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            revisionId: revision.id,
            type: 'schedule',
        })
        return this.getEntry(entryId)
    }

    async cancelScheduledPublish(entryId: string, input: { expectedVersion: number }): Promise<EntryRecord> {
        await this.initialize()
        await this.#requiredEntry(entryId)
        const time = this.#now()
        await this.#commit([
            {
                expectRow: true,
                params: [time, entryId, input.expectedVersion],
                query: true,
                sql: `UPDATE site_admin_entries
                      SET scheduled_revision_id = NULL, scheduled_at = NULL, version = version + 1, updated_at = ?
                      WHERE id = ? AND version = ? RETURNING version`,
            },
        ])
        await this.#requireAssetSync()
        return this.getEntry(entryId)
    }

    async publishDue(now = this.#date()): Promise<PublishDueResult> {
        await this.initialize()
        const due = await queryRows<{
            id: string
            scheduled_revision_id: string
            version: number
        }>(
            this.#options.database,
            `SELECT id, scheduled_revision_id, version FROM site_admin_entries
             WHERE scheduled_revision_id IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at`,
            [now.toISOString()],
        )
        const result: PublishDueResult = { failed: [], published: [] }
        for (const entry of due) {
            try {
                await this.publishEntry(entry.id, {
                    expectedVersion: Number(entry.version),
                    revisionId: entry.scheduled_revision_id,
                })
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
        const input = JSON.stringify(items)
        // One shared precondition protects every row, including native D1 batches.
        const valid = `NOT EXISTS (SELECT 1 FROM json_each(?) item LEFT JOIN site_admin_entries e
            ON e.id = json_extract(item.value, '$.id') WHERE e.id IS NULL OR e.model != ?
            OR e.version != json_extract(item.value, '$.expectedVersion'))`
        const time = this.#now()
        await this.#commit([
            this.#generationStatement({
                clause:
                    valid +
                    ` AND EXISTS (SELECT 1 FROM site_admin_entries WHERE published_revision_id IS NOT NULL AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?)))`,
                params: [input, model, input],
            }),
            {
                expectRow: true,
                query: true,
                params: [input, model, input, time, time],
                sql: `WITH valid(ok) AS MATERIALIZED (SELECT ${valid}),
                    items AS MATERIALIZED (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.sortOrder') AS sort_order FROM json_each(?))
                    UPDATE site_admin_entries SET sort_order = (SELECT sort_order FROM items WHERE items.id = site_admin_entries.id),
                    published_at = CASE WHEN published_revision_id IS NOT NULL THEN ? ELSE published_at END,
                    version = version + 1, updated_at = ?
                    WHERE (SELECT ok FROM valid) AND id IN (SELECT id FROM items) RETURNING id`,
            },
        ])
        return Promise.all(items.map((item) => this.getEntry(item.id)))
    }

    async deleteEntry(entryId: string, input: { actorId?: string; expectedVersion: number }): Promise<void> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const incoming = await queryRow<{ revision_id: string }>(
            this.#options.database,
            'SELECT revision_id FROM site_admin_relations WHERE target_entry_id = ? LIMIT 1',
            [entryId],
        )
        if (incoming) {
            throw new SiteAdminError('SITE_ADMIN_RELATION_BLOCKED', 'Retained revisions still reference this entry.')
        }
        const guard = this.#guard(entryId, input.expectedVersion)
        const statements: AtomicStatement[] = [
            {
                params: [entryId, ...guard.params],
                sql: `DELETE FROM site_admin_routes WHERE entry_id = ? AND ${guard.clause}`,
            },
            {
                params: [entryId, ...guard.params],
                sql: `DELETE FROM site_admin_asset_refs WHERE revision_id IN (
                          SELECT id FROM site_admin_revisions WHERE entry_id = ?
                      ) AND ${guard.clause}`,
            },
            {
                params: [entryId, ...guard.params],
                sql: `DELETE FROM site_admin_relations WHERE revision_id IN (
                          SELECT id FROM site_admin_revisions WHERE entry_id = ?
                      ) AND ${guard.clause}`,
            },
            {
                params: [entryId, ...guard.params],
                sql: `DELETE FROM site_admin_revisions WHERE entry_id = ? AND ${guard.clause}`,
            },
        ]
        if (entry.published_revision_id) statements.push(this.#generationStatement(guard))
        statements.push({
            expectRow: true,
            params: [entryId, input.expectedVersion],
            query: true,
            sql: 'DELETE FROM site_admin_entries WHERE id = ? AND version = ? RETURNING id',
        })
        await this.#commit(statements)
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            type: 'delete',
        })
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
        const conditions = ['e.published_revision_id IS NOT NULL', 'e.published_at IS NOT NULL']
        const params: string[] = []
        if (modelName) {
            conditions.push('e.model = ?')
            params.push(modelName)
        }
        if (ids) {
            if (ids.length === 0) return []
            conditions.push(`e.id IN (${placeholders(ids.length)})`)
            params.push(...ids)
        }
        if (locale !== undefined) {
            conditions.push('e.locale = ?')
            params.push(locale)
        }
        return queryRows<PublishedRow>(
            this.#options.database,
            `SELECT e.id, e.model, e.locale, e.published_at, e.translation_group,
                    r.id AS revision_id, r.data, r.slug
             FROM site_admin_entries e
             JOIN ${this.#revisionSource} r ON r.id = e.published_revision_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY e.sort_order IS NULL, e.sort_order, e.published_at DESC`,
            params,
        )
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
                const stored = parseObject(row.data)
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
            const rows = await queryRows<{ id: string }>(
                this.#options.database,
                `SELECT id FROM site_admin_assets WHERE state = 'ready' AND id IN (${placeholders(assetIds.size)})`,
                [...assetIds],
            )
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
            modelGroups.add(row.translation_group)
            groups.set(row.model, modelGroups)
        }
        const rows = new Map(roots.map((row) => [row.id, row]))
        for (const [model, translationGroups] of groups) {
            const groupIds = [...translationGroups]
            // D1 permits 100 bound parameters per query; reserve one for the model.
            for (let offset = 0; offset < groupIds.length; offset += 99) {
                const chunk = groupIds.slice(offset, offset + 99)
                const alternates = await queryRows<PublishedRow>(
                    this.#options.database,
                    `SELECT e.id, e.model, e.locale, e.published_at, e.translation_group,
                        r.id AS revision_id, r.data, r.slug
                 FROM site_admin_entries e
                 JOIN ${this.#revisionSource} r ON r.id = e.published_revision_id
                 WHERE e.model = ? AND e.translation_group IN (${placeholders(chunk.length)})
                       AND e.published_at IS NOT NULL`,
                    [model, ...chunk],
                )
                for (const row of alternates) rows.set(row.id, row)
            }
        }
        return this.#publicSnapshot([...rows.values()])
    }

    #publishedPath(row: PublishedRow): string | null {
        const definition = this.#publicModel(row.model)
        if (!definition) return null
        const redirect = routeRedirect(definition, parseObject(row.data))
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
                publishedAt: row.published_at,
                revisionId: row.revision_id,
                slug: row.slug,
            }
        }
        const trail = new Set(parentTrail).add(row.id)
        const entry: PublicEntry = {
            data: this.#hydrateFields(definition.fields, parseObject(row.data), graph, trail, budget, markdownSource),
            id: row.id,
            locale: row.locale,
            model: row.model,
            path,
            publishedAt: row.published_at,
            revisionId: row.revision_id,
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
                    const key = `${alternate.model}\0${alternate.translation_group}`
                    const alternates = budget.alternates.get(key) ?? []
                    alternates.push({ locale: alternate.locale, path: alternatePath })
                    budget.alternates.set(key, alternates)
                }
            }
            entry.alternates = (budget.alternates.get(`${row.model}\0${row.translation_group}`) ?? []).map(
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
        const row = await queryRow<PublishedRow>(
            this.#options.database,
            `SELECT e.id, e.model, e.locale, e.published_at, e.translation_group,
                    r.id AS revision_id, r.data, r.slug
             FROM site_admin_entries e
             JOIN ${this.#revisionSource} r ON r.id = e.published_revision_id
             WHERE e.model = ? AND e.locale = ? AND e.published_revision_id IS NOT NULL AND (r.slug = ? OR e.id = ?)
             LIMIT 1`,
            [modelName, normalizedLocale, slugOrId, slugOrId],
        )
        if (!row) return null
        const graph = await this.#publicEntryGraph([row])
        return graph.has(row.id) ? this.#projectPublished(row, graph) : null
    }

    async publicGeneration(): Promise<number> {
        await this.initialize()
        const row = await queryRow<MetaRow>(
            this.#options.database,
            "SELECT value FROM site_admin_meta WHERE key = 'public_generation'",
        )
        return Number(row?.value ?? 0)
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
        const content = createMarkdownContent(modelName, definition, entries, this.config.markdown, (id) =>
            this.#assetUrl(id),
        )
        content.hooks.hook('file:parsed', ({ file }) => {
            if (!file) return
            const metadata = file.data['_siteAdmin']
            const description = this.#entryDescription(definition, file.data)
            if (isObject(metadata) && description !== undefined)
                metadata.seo = { ...serializeSiteAdminSeo(metadata.seo), description }
        })
        this.#content.set(cacheKey, { content, generation })
        if (this.#content.size > 64) this.#content.delete(this.#content.keys().next().value!)
        return content
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
            const routes = await queryRows<RouteRow>(
                this.#options.database,
                `SELECT * FROM site_admin_routes WHERE locale IN (?, '') ORDER BY locale = '' ASC`,
                [normalizedLocale],
            )
            for (const route of routes) addRoute(router, 'GET', route.path, route)
            this.#routes.set(normalizedLocale, { generation, router })
            if (this.#routes.size > 64) this.#routes.delete(this.#routes.keys().next().value!)
        }
        const normalizedPath = new URL(path, 'http://site-admin.local').pathname
        const match = findRoute(this.#routes.get(normalizedLocale)!.router, 'GET', normalizedPath, { normalize: true })
        if (!match) return null
        const route = match.data
        const rows = await this.#publishedRows(undefined, [route.entry_id])
        const entry = rows[0]
        if (!entry) return null
        const graph = await this.#publicEntryGraph([entry])
        if (!graph.has(entry.id)) return null
        if (route.kind === 'page') {
            const budget = { nodes: 0 }
            const projected = this.#projectPublished(entry, graph, new Set(), budget)
            // Keep the existing route DTO's self alternate for nonlocalized entries.
            projected.alternates ??= projected.path ? [{ locale: projected.locale, path: projected.path }] : []
            return { entry: projected, kind: 'page' }
        }
        if (!route.target_path) return null
        return { kind: 'redirect', status: route.status ?? 302, target: route.target_path }
    }

    async sitemap(): Promise<Array<{ loc: string; lastmod?: string }>> {
        await this.initialize()
        const routes = await queryRows<RouteRow>(
            this.#options.database,
            `SELECT * FROM site_admin_routes WHERE kind = 'page' ORDER BY path`,
        )
        const rows = await this.#publishedRows(undefined, [...new Set(routes.map((route) => route.entry_id))])
        const graph = await this.#publicSnapshot(rows)
        const byId = new Map(rows.map((row) => [row.id, row]))
        return routes.flatMap((route) => {
            const row = byId.get(route.entry_id)
            const definition = row && this.#publicModel(row.model)
            const options = definition ? modelRouteOptions(definition) : null
            return row &&
                graph.has(row.id) &&
                (this.#resolveRouteRule(route.path).sitemap ?? options?.sitemap) !== false
                ? [{ lastmod: row.published_at, loc: decodeURI(route.path) }]
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
        return (
            await queryRows<RouteRow>(this.#options.database, 'SELECT * FROM site_admin_routes ORDER BY locale, path')
        ).map((route) => ({
            entryId: route.entry_id,
            kind: route.kind,
            locale: route.locale,
            path: route.path,
            status: route.status,
            targetPath: route.target_path,
        }))
    }

    async inspect(): Promise<SiteAdminInspection> {
        await this.initialize()
        const entryRows = await queryRows<{
            drafts: number
            model: string
            published: number
            scheduled: number
            total: number
        }>(
            this.#options.database,
            `SELECT model,
                    COUNT(*) AS total,
                    SUM(CASE WHEN published_revision_id IS NOT NULL THEN 1 ELSE 0 END) AS published,
                    SUM(CASE WHEN current_revision_id <> published_revision_id OR published_revision_id IS NULL THEN 1 ELSE 0 END) AS drafts,
                    SUM(CASE WHEN scheduled_revision_id IS NOT NULL THEN 1 ELSE 0 END) AS scheduled
             FROM site_admin_entries GROUP BY model ORDER BY model`,
        )
        const assetRows = await queryRows<{ count: number; state: string }>(
            this.#options.database,
            'SELECT state, COUNT(*) AS count FROM site_admin_assets GROUP BY state ORDER BY state',
        )
        const orphan = await queryRow<{ count: number }>(
            this.#options.database,
            `SELECT COUNT(*) AS count FROM site_admin_assets assets
             WHERE assets.state IN ('ready', 'delete_failed', 'upload_failed')
               AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs refs WHERE refs.asset_id = assets.id)`,
        )
        return {
            assets: Object.fromEntries(assetRows.map((row) => [row.state, Number(row.count)])),
            diagnostics: structuredClone(this.diagnostics),
            entries: Object.fromEntries(
                entryRows.map((row) => [
                    row.model,
                    {
                        drafts: Number(row.drafts),
                        published: Number(row.published),
                        scheduled: Number(row.scheduled),
                        total: Number(row.total),
                    },
                ]),
            ),
            orphanAssets: Number(orphan?.count ?? 0),
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
            await this.#commit([
                {
                    params: [
                        id,
                        storage,
                        key,
                        contentType,
                        upload.size,
                        null,
                        JSON.stringify(input.metadata ?? {}),
                        'uploading',
                        token,
                        lease,
                        time,
                        time,
                    ],
                    sql: `INSERT INTO site_admin_assets(
                    id, storage, key, content_type, size, checksum, metadata, state,
                    operation_token, lease_expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                },
            ])
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
            await this.#commit([
                {
                    expectRow: true,
                    params: [contentType, result.size, hash, this.#now(), id, token],
                    query: true,
                    sql: `UPDATE site_admin_assets SET content_type = ?, size = ?, checksum = ?, state = 'ready',
                          operation_token = NULL, lease_expires_at = NULL, updated_at = ?
                          WHERE id = ? AND state = 'uploading' AND operation_token = ? RETURNING id`,
                },
            ])
        } catch (error) {
            abort.abort(error)
            await upload.cancel(error).catch(() => {})
            await pumping?.catch(() => {})
            try {
                if (await files.exists(key)) await files.delete(key)
            } catch {}
            await this.#commit([
                {
                    params: [this.#now(), id, token],
                    sql: `UPDATE site_admin_assets SET state = 'upload_failed', operation_token = NULL,
                          lease_expires_at = NULL, updated_at = ?
                          WHERE id = ? AND state = 'uploading' AND operation_token = ?`,
                },
            ])
            throw error
        }
        return this.getAsset(id)
    }

    async getAsset(id: string): Promise<AssetRecord> {
        await this.initialize()
        const row = await queryRow<AssetRow>(this.#options.database, 'SELECT * FROM site_admin_assets WHERE id = ?', [
            id,
        ])
        if (!row) throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', `Asset "${id}" does not exist.`)
        return toAsset(row)
    }

    async downloadAsset(id: string, publicOnly = true): Promise<DownloadedAsset> {
        await this.initialize()
        const asset = await this.getAsset(id)
        if (asset.state !== 'ready') {
            throw new SiteAdminError('SITE_ADMIN_ASSET_NOT_READY', `Asset "${id}" is not ready.`)
        }
        if (publicOnly) {
            const sources = await queryRows<{ id: string }>(
                this.#options.database,
                `SELECT entries.id FROM site_admin_asset_refs refs
                 JOIN site_admin_entries entries ON entries.published_revision_id = refs.revision_id
                 WHERE refs.asset_id = ?`,
                [id],
            )
            const rows = await this.#publishedRows(
                undefined,
                sources.map((source) => source.id),
            )
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
        const reference = await queryRow<{ revision_id: string }>(
            this.#options.database,
            'SELECT revision_id FROM site_admin_asset_refs WHERE asset_id = ? LIMIT 1',
            [id],
        )
        if (reference) throw new SiteAdminError('SITE_ADMIN_ASSET_IN_USE', 'A retained revision still uses this Asset.')
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
        await this.#commit([
            {
                expectRow: true,
                params: [token, this.#leaseExpiresAt(), now, id, now],
                query: true,
                sql: `UPDATE site_admin_assets SET state = 'deleting', operation_token = ?, lease_expires_at = ?, updated_at = ?
                      WHERE id = ? AND (
                          state IN ('ready', 'delete_failed', 'upload_failed')
                          OR (state IN ('uploading', 'deleting') AND lease_expires_at <= ?)
                      )
                        AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs WHERE asset_id = site_admin_assets.id)
                      RETURNING id`,
            },
        ])
        return token
    }

    async #deleteClaimedAsset(asset: AssetRecord, token: string): Promise<void> {
        try {
            if (!this.#options.getFiles) {
                throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
            }
            const files = await this.#options.getFiles(asset.storage)
            if (await files.exists(asset.key)) await files.delete(asset.key)
            await this.#commit([
                {
                    expectRow: true,
                    params: [this.#now(), asset.id, token],
                    query: true,
                    sql: `UPDATE site_admin_assets SET state = 'deleted', operation_token = NULL,
                          lease_expires_at = NULL, updated_at = ?
                          WHERE id = ? AND state = 'deleting' AND operation_token = ? RETURNING id`,
                },
            ])
        } catch (error) {
            await this.#commit([
                {
                    params: [this.#now(), asset.id, token],
                    sql: `UPDATE site_admin_assets SET state = 'delete_failed', operation_token = NULL,
                          lease_expires_at = NULL, updated_at = ?
                          WHERE id = ? AND state = 'deleting' AND operation_token = ?`,
                },
            ])
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
        const candidates = await queryRows<AssetRow>(
            this.#options.database,
            `SELECT assets.* FROM site_admin_assets assets
             WHERE ((assets.state IN ('ready', 'delete_failed', 'upload_failed') AND assets.created_at <= ?)
                    OR (assets.state IN ('uploading', 'deleting') AND assets.lease_expires_at <= ?))
               AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs refs WHERE refs.asset_id = assets.id)`,
            [cutoff, this.#now()],
        )
        const result: { deleted: string[]; failed: Array<{ id: string; message: string }> } = {
            deleted: [],
            failed: [],
        }
        for (const row of candidates) {
            const asset = toAsset(row)
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
        const rows = await queryRows<{ key: string; value: string }>(
            this.#options.database,
            "SELECT key, value FROM site_admin_meta WHERE key LIKE 'asset_copy:%' ORDER BY key",
        )
        return rows.map((row) => ({ ledger: row.key, copy: JSON.parse(row.value) as AssetCopy }))
    }

    async #desiredAssetCopies(): Promise<Set<string>> {
        const graph = await this.#publicSnapshot(await this.#publishedRows())
        const ids = new Set<string>()
        for (const row of graph.values()) {
            const definition = this.#publicModel(row.model)
            if (definition)
                for (const reference of collectReferences(definition.fields, parseObject(row.data)).assets)
                    ids.add(reference.id)
        }
        return ids
    }

    async #retireAssetCopy(ledger: string, copy: AssetCopy, guard?: SqlGuard): Promise<void> {
        // ponytail: keep tombstones for late storage writes; compact after enforcing storage-operation deadlines.
        await this.#commit([
            {
                sql: `UPDATE site_admin_meta SET value = ? WHERE key = ?${guard ? ` AND ${guard.clause}` : ''} RETURNING key`,
                params: [JSON.stringify({ ...copy, state: 'retired' }), ledger, ...(guard?.params ?? [])],
                query: true,
                expectRow: true,
            },
        ])
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
        const lease = `${this.#leaseExpiresAt()}|${this.#id()}`
        const owner = (): SqlGuard => ({
            clause: "EXISTS (SELECT 1 FROM site_admin_meta WHERE key = 'asset_sync_lease' AND value = ? AND value > ?)",
            params: [lease, `${this.#now()}|~`],
        })
        const generation = async (): Promise<string> =>
            (
                await queryRow<MetaRow>(
                    this.#options.database,
                    "SELECT value FROM site_admin_meta WHERE key = 'public_generation'",
                )
            )?.value ?? '0'
        try {
            await this.#commit([
                {
                    sql: "INSERT INTO site_admin_meta(key, value) VALUES ('asset_sync_lease', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE site_admin_meta.value <= ? RETURNING value",
                    params: [lease, `${this.#now()}|~`],
                    query: true,
                    expectRow: true,
                },
            ])
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
                const ledger = `asset_copy:${id}:${token}`
                const copy: AssetCopy = {
                    assetId: id,
                    key: `site-admin/public/${id}/${token}`,
                    state: 'copying',
                    storage: this.config.assets.storage!,
                }
                const guard = owner()
                let recorded = false
                try {
                    await this.#commit([
                        {
                            sql: `INSERT INTO site_admin_meta(key, value) SELECT ?, ? WHERE ${guard.clause} RETURNING key`,
                            params: [ledger, JSON.stringify(copy), ...guard.params],
                            query: true,
                            expectRow: true,
                        },
                    ])
                    recorded = true
                    const asset = await queryRow<AssetRow>(
                        this.#options.database,
                        "SELECT * FROM site_admin_assets WHERE id = ? AND storage = 'draft' AND state = 'ready'",
                        [id],
                    )
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
                        const stored = await stores.public.upload(copy.key, body, { contentType: asset.content_type })
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
                    const currentOwner = owner()
                    await this.#commit([
                        {
                            sql: `UPDATE site_admin_meta SET value = ? WHERE key = ? AND ${currentOwner.clause} AND COALESCE((SELECT value FROM site_admin_meta WHERE key = 'public_generation'), '0') = ? RETURNING key`,
                            params: [
                                JSON.stringify({ ...copy, state: 'ready' }),
                                ledger,
                                ...currentOwner.params,
                                currentGeneration,
                            ],
                            query: true,
                            expectRow: true,
                        },
                    ])
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
            await this.#commit([
                { sql: "DELETE FROM site_admin_meta WHERE key = 'asset_sync_lease' AND value = ?", params: [lease] },
            ])
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
