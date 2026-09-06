import { comarkContent, type ComarkContent, type Source } from 'comark-content'
import json from 'comark-content/plugins/json'
import markdownFields, { markdownField } from 'comark-content/plugins/markdown-fields'
import type { JsonSchema } from 'comark-content'
import summary from 'comark/plugins/summary'
import { addRoute, createRouter, findRoute, type RouterContext } from 'rou3'

import type { ModelDefinition, SiteAdminLifecycleEvent } from '../config'
import { createSiteAdminDescriptor, type SiteAdminDescriptor } from '../descriptor'
import { SiteAdminError, type SiteAdminIssue } from '../errors'
import type { AnyField, AssetInput, FieldRecord } from '../fields'
import {
    applyFieldDefaults,
    collectReferences,
    fieldAtPath,
    validateModelData,
    type IndexedReference,
} from '../validation'
import { queryRow, queryRows, runAtomic, type AtomicStatement } from './database'
import { entryPath, preferredSlugSource, routeRedirect, slugify, validateSlug } from './routes'
import { initializeSiteAdminDatabase } from './schema'
import type {
    AssetRecord,
    DownloadedAsset,
    EntryInput,
    EntryRecord,
    PublicEntry,
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
    schema_version: number
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
    metadata: string
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
    revision_id: string
    slug: string
}

interface RouteRow {
    entry_id: string
    kind: 'historical' | 'page' | 'redirect'
    path: string
    revision_id: string | null
    status: number | null
    target_path: string | null
}

interface IncomingReferenceRow {
    field_path: string
    model: string
    revision_id: string
}

interface MetaRow {
    value: string
}

interface SqlGuard {
    clause: string
    params: Array<number | string>
}

interface MarkdownDocumentValue {
    meta?: { summary?: unknown }
    nodes: unknown[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const markdownDocument = (value: unknown): MarkdownDocumentValue | undefined => {
    if (!isObject(value) || !Array.isArray(value.nodes)) return undefined
    const meta = isObject(value.meta) ? value.meta : undefined
    return { ...(meta ? { meta } : {}), nodes: value.nodes }
}

const astText = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
        if ((typeof value[0] === 'string' || value[0] === null) && isObject(value[1])) {
            return value.slice(2).map(astText).filter(Boolean).join(' ')
        }
        return value.map(astText).filter(Boolean).join(' ')
    }
    if (!isObject(value)) return ''
    if (typeof value.value === 'string') return value.value
    return astText(value.children ?? value.nodes)
}

const cleanText = (value: string): string => value.replace(/\s+/gu, ' ').trim()

const collectMarkdown = (field: AnyField, value: unknown, output: MarkdownDocumentValue[]): void => {
    if (field.kind === 'markdown') {
        const document = markdownDocument(value)
        if (document) output.push(document)
        return
    }
    if (field.kind === 'object' && isObject(value)) {
        for (const [name, child] of Object.entries(field.fields)) collectMarkdown(child, value[name], output)
        return
    }
    if (field.kind === 'array' && Array.isArray(value)) {
        for (const item of value) collectMarkdown(field.item, item, output)
    }
}

const parseObject = (value: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', 'Stored revision data is not an object.')
    }
    return parsed as Record<string, unknown>
}

const toEntry = (row: EntryRow): EntryRecord => ({
    createdAt: row.created_at,
    currentRevisionId: row.current_revision_id,
    data: parseObject(row.data),
    id: row.id,
    locale: row.locale,
    model: row.model,
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
    schemaVersion: Number(row.schema_version),
    slug: row.slug,
})

const toAsset = (row: AssetRow): AssetRecord => ({
    checksum: row.checksum,
    contentType: row.content_type,
    createdAt: row.created_at,
    id: row.id,
    key: row.key,
    metadata: parseObject(row.metadata) as Record<string, string>,
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
    accepted.some(
        (entry) => entry === value || (entry.endsWith('/*') && value.startsWith(entry.slice(0, -1))),
    )

const durationMilliseconds = (value: string): number => {
    const match = /^(\d+)(ms|s|m|h|d)$/u.exec(value)
    if (!match) throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Invalid duration "${value}".`)
    const amount = Number(match[1])
    const unit = match[2]
    return amount * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit ?? 'ms'] ?? 1)
}

const bytesFromBody = async (body: UploadAssetInput['body'], maxSize: number): Promise<Uint8Array> => {
    const bounded = (value: Uint8Array): Uint8Array => {
        if (value.byteLength > maxSize) {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Upload exceeds the ${maxSize}-byte limit.`)
        }
        return value
    }
    if (typeof body === 'string') return bounded(new TextEncoder().encode(body))
    if (body instanceof Uint8Array) return bounded(body)
    if (body instanceof ArrayBuffer) return bounded(new Uint8Array(body))
    if (ArrayBuffer.isView(body))
        return bounded(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
    if (body instanceof Blob) return bounded(new Uint8Array(await body.arrayBuffer()))
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.byteLength
        if (size > maxSize) {
            await reader.cancel()
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Upload exceeds the ${maxSize}-byte limit.`)
        }
    }
    const output = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
    }
    return output
}

const detectedMime = (bytes: Uint8Array, fallback?: string): string => {
    const starts = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value)
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
    if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
    if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
    if (starts(0x52, 0x49, 0x46, 0x46) && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP')
        return 'image/webp'
    if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'
    return fallback?.startsWith('text/') ? fallback : 'application/octet-stream'
}

const checksum = async (bytes: Uint8Array): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const fieldSchema = (field: AnyField): JsonSchema => {
    switch (field.kind) {
        case 'markdown':
            return markdownField()
        case 'text':
        case 'textarea':
        case 'url':
        case 'datetime':
        case 'select':
            return { type: 'string' }
        case 'number':
            return { type: field.integer ? 'integer' : 'number' }
        case 'boolean':
            return { type: 'boolean' }
        case 'object':
            return fieldsSchema(field.fields)
        case 'array':
            return { items: fieldSchema(field.item), type: 'array' }
        case 'images':
            return { items: { type: 'object' }, type: 'array' }
        case 'file':
        case 'image':
        case 'relation':
            return { type: 'object' }
    }
    throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', 'Unsupported field type.')
}

const fieldsSchema = (fields: FieldRecord): JsonSchema => ({
    properties: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldSchema(field)])),
    type: 'object',
})

export class SiteAdmin {
    readonly diagnostics: SiteAdminDiagnostic[] = []
    readonly #options: SiteAdminOptions
    readonly #descriptor: SiteAdminDescriptor
    readonly #content = new Map<string, { content: ComarkContent; generation: number }>()
    #routes?: { generation: number; router: RouterContext<RouteRow> }
    #initializer: Promise<void> | undefined

    constructor(options: SiteAdminOptions) {
        this.#options = options
        this.#descriptor = createSiteAdminDescriptor(options.config)
    }

    get config(): SiteAdminOptions['config'] {
        return this.#options.config
    }

    get descriptor(): SiteAdminDescriptor {
        return structuredClone(this.#descriptor)
    }

    async authorizeRequest(request: Request): Promise<import('./types').SiteAdminActor> {
        const actor = await this.#options.authorize?.(request)
        if (!actor?.id) throw new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'Authentication is required.')
        return actor
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
        await initializeSiteAdminDatabase(this.#options.database)
    }

    #validateConfig(): void {
        for (const [modelName, definition] of Object.entries(this.config.models)) {
            safeId(modelName, 'Model name')
            if (Object.hasOwn(definition.fields, '_siteAdmin')) {
                throw new SiteAdminError(
                    'SITE_ADMIN_INVALID_INPUT',
                    '"_siteAdmin" is reserved for public metadata.',
                )
            }
            for (const [fieldName, field] of Object.entries(definition.fields)) {
                safeId(fieldName, `Field name in model "${modelName}"`)
                this.#validateFieldConfig(field)
            }
            if (typeof definition.route === 'object' && definition.route.redirect) {
                const field = definition.fields[definition.route.redirect]
                if (field?.kind !== 'url') {
                    throw new SiteAdminError(
                        'SITE_ADMIN_INVALID_INPUT',
                        `Redirect field "${definition.route.redirect}" in model "${modelName}" must be a URL field.`,
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

    async #entryRow(id: string): Promise<EntryRow | undefined> {
        return queryRow<EntryRow>(
            this.#options.database,
            `SELECT e.*, r.id AS revision_id, r.data, r.slug
             FROM site_admin_entries e
             JOIN site_admin_revisions r ON r.id = e.current_revision_id
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
             JOIN site_admin_revisions r ON r.id = e.current_revision_id
             ${modelName ? 'WHERE e.model = ?' : ''}
             ORDER BY e.sort_order IS NULL, e.sort_order, e.updated_at DESC`,
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
                'SELECT * FROM site_admin_revisions WHERE entry_id = ? ORDER BY created_at DESC',
                [entryId],
            )
        ).map(toRevision)
    }

    async #revision(id: string, entryId?: string): Promise<RevisionRow> {
        const row = await queryRow<RevisionRow>(
            this.#options.database,
            `SELECT * FROM site_admin_revisions WHERE id = ?${entryId ? ' AND entry_id = ?' : ''}`,
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
            if (!target)
                issues.push({ message: `Entry "${reference.id}" does not exist.`, path: reference.path })
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
            } else if (
                field &&
                'accept' in field &&
                field.accept &&
                !mimeMatches(asset.content_type, field.accept)
            ) {
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
        const values = [
            input.revisionId,
            input.entryId,
            JSON.stringify(input.data),
            input.slug,
            input.actorId ?? null,
            input.model.schemaVersion ?? 1,
            input.time,
        ]
        const statements: AtomicStatement[] = [
            guard
                ? {
                      sql: `INSERT INTO site_admin_revisions(id, entry_id, data, slug, actor_id, schema_version, created_at)
                            SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.clause}`,
                      params: [...values, ...guard.params],
                  }
                : {
                      sql: `INSERT INTO site_admin_revisions(id, entry_id, data, slug, actor_id, schema_version, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`,
                      params: values,
                  },
        ]
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
        revisionId: string
        slug: string
        time: string
    }): Promise<AtomicStatement[]> {
        const redirect = routeRedirect(input.definition, input.data)
        const current = await this.#currentRoute(input.entryId)
        const path =
            this.#options.routing?.enabled === false ||
            (redirect && this.#options.routing?.redirects === false)
                ? null
                : input.definition.public === false
                  ? null
                  : entryPath(input.modelName, input.definition, input.slug, this.#apiBases())
        const guard = input.guard
        const guardedDelete = (sql: string, params: Array<string | number>): AtomicStatement =>
            guard
                ? { sql: `${sql} AND ${guard.clause}`, params: [...params, ...guard.params] }
                : { sql, params }
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
            guardedDelete(
                "DELETE FROM site_admin_routes WHERE entry_id = ? AND kind IN ('page', 'redirect')",
                [input.entryId],
            ),
        )
        if (!path) return statements
        statements.push(
            guardedDelete('DELETE FROM site_admin_routes WHERE entry_id = ? AND path = ?', [
                input.entryId,
                path,
            ]),
        )
        if (current && current.path !== path && this.#options.routing?.preserveHistory !== false) {
            const values = [
                current.path,
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
                          sql: `INSERT INTO site_admin_routes(path, entry_id, revision_id, kind, target_path, status, created_at)
                                SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.clause}`,
                          params: [...values, ...guard.params],
                      }
                    : {
                          sql: `INSERT INTO site_admin_routes(path, entry_id, revision_id, kind, target_path, status, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                          params: values,
                      },
            )
        }
        const values = [
            path,
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
                      sql: `INSERT INTO site_admin_routes(path, entry_id, revision_id, kind, target_path, status, created_at)
                            SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.clause}`,
                      params: [...values, ...guard.params],
                  }
                : {
                      sql: `INSERT INTO site_admin_routes(path, entry_id, revision_id, kind, target_path, status, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`,
                      params: values,
                  },
        )
        return statements
    }

    #generationStatement(guard?: SqlGuard): AtomicStatement {
        if (guard) {
            return {
                sql: `UPDATE site_admin_meta SET value = CAST(value AS INTEGER) + 1
                      WHERE key = 'public_generation' AND ${guard.clause}`,
                params: guard.params,
            }
        }
        return {
            sql: "UPDATE site_admin_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'public_generation'",
        }
    }

    async #commit(statements: AtomicStatement[], routeMutation = false): Promise<void> {
        try {
            await runAtomic(this.#options.database, statements)
        } catch (error) {
            if (
                routeMutation &&
                !(error instanceof SiteAdminError) &&
                error instanceof Error &&
                /site_admin_routes(?:\.path)?/iu.test(error.message)
            ) {
                throw new SiteAdminError(
                    'SITE_ADMIN_ROUTE_CONFLICT',
                    'Another public route already owns this path.',
                )
            }
            throw error
        }
    }

    async #afterCommit(event: SiteAdminLifecycleEvent): Promise<void> {
        if (!this.config.hooks?.afterCommit) return
        try {
            await this.config.hooks.afterCommit(event)
        } catch (error) {
            this.diagnostics.push({
                code: 'SITE_ADMIN_HOOK_FAILED',
                message: error instanceof Error ? error.message : 'A post-commit hook failed.',
            })
        }
    }

    async createEntry(modelName: string, input: EntryInput): Promise<EntryRecord> {
        await this.initialize()
        const definition = this.#model(modelName)
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
                    id, model, locale, translation_group, sort_order, version, created_at, updated_at
                ) SELECT ?, ?, ?, ?, ?, 0, ?, ? WHERE ${guard.clause}`,
                      params: [
                          id,
                          modelName,
                          input.locale ?? '',
                          input.translationGroup ?? id,
                          input.sortOrder ?? null,
                          time,
                          time,
                          ...guard.params,
                      ],
                  }
                : {
                      sql: `INSERT INTO site_admin_entries(
                    id, model, locale, translation_group, sort_order, version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
                      params: [
                          id,
                          modelName,
                          input.locale ?? '',
                          input.translationGroup ?? id,
                          input.sortOrder ?? null,
                          time,
                          time,
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
            await this.#assertPublishableRelations(definition, prepared.relations)
            statements.push(
                ...(await this.#routeStatements({
                    data: prepared.data,
                    definition,
                    entryId: id,
                    ...(guard ? { guard } : {}),
                    modelName,
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
        await this.#commit(statements, published)
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
            await this.#assertPublishableRelations(definition, prepared.relations)
            statements.push(
                ...(await this.#routeStatements({
                    data: prepared.data,
                    definition,
                    entryId,
                    ...(guard ? { guard } : {}),
                    modelName: entry.model,
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
                input.sortOrder === undefined ? entry.sort_order : input.sortOrder,
                time,
                entryId,
                input.expectedVersion,
                ...(guard?.params ?? []),
            ],
            query: true,
            sql: `UPDATE site_admin_entries SET current_revision_id = ?${published ? ', published_revision_id = ?' : ''},
                  sort_order = ?, version = version + 1, updated_at = ?
                  WHERE id = ? AND version = ?${guard ? ` AND ${guard.clause}` : ''} RETURNING version`,
        })
        await this.#commit(statements, published)
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
    ): Promise<void> {
        const required = references.filter((reference) => {
            const field = fieldAtPath(definition.fields, reference.path)
            return field?.kind === 'relation' && field.required
        })
        if (required.length === 0) return
        const ids = [...new Set(required.map((reference) => reference.id))]
        const rows = await queryRows<ReferenceTargetRow>(
            this.#options.database,
            `SELECT id, model, published_revision_id FROM site_admin_entries WHERE id IN (${placeholders(ids.length)})`,
            ids,
        )
        const published = new Set(
            rows
                .filter((row) => row.published_revision_id && this.config.models[row.model]?.public !== false)
                .map((row) => row.id),
        )
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
    }

    async publishEntry(
        entryId: string,
        input: { actorId?: string; expectedVersion: number; revisionId?: string },
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const definition = this.#model(entry.model)
        const revision = await this.#revision(input.revisionId ?? entry.current_revision_id, entryId)
        const data = parseObject(revision.data)
        const references = collectReferences(definition.fields, data)
        await this.#assertReferences(definition, references)
        await this.#assertPublishableRelations(definition, references.relations)
        const time = this.#now()
        const guard = this.#combineGuards(
            this.#guard(entryId, input.expectedVersion),
            this.#referenceGuard(definition, references, true),
        )
        const statements: AtomicStatement[] = [
            ...(await this.#routeStatements({
                data,
                definition,
                entryId,
                ...(guard ? { guard } : {}),
                modelName: entry.model,
                revisionId: revision.id,
                slug: revision.slug,
                time,
            })),
            this.#generationStatement(guard),
            {
                expectRow: true,
                params: [revision.id, time, entryId, input.expectedVersion, ...(guard?.params ?? [])],
                query: true,
                sql: `UPDATE site_admin_entries
                      SET published_revision_id = ?, scheduled_revision_id = NULL, scheduled_at = NULL,
                          version = version + 1, updated_at = ?
                      WHERE id = ? AND version = ?${guard ? ` AND ${guard.clause}` : ''} RETURNING version`,
            },
        ]
        await this.#commit(statements, true)
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
        if (incoming.length > 0) {
            throw new SiteAdminError(
                'SITE_ADMIN_RELATION_BLOCKED',
                'Published entries contain required relations to this entry.',
                incoming.map((reference) => ({
                    message: 'Required published relation would be broken.',
                    path: reference.field_path,
                })),
            )
        }
    }

    #unpublishGuard(entryId: string): SqlGuard {
        return {
            clause: `NOT EXISTS (
                SELECT 1 FROM site_admin_relations rel
                JOIN site_admin_entries source ON source.published_revision_id = rel.revision_id
                WHERE rel.target_entry_id = ? AND source.id <> ? AND rel.required = 1
            )`,
            params: [entryId, entryId],
        }
    }

    async unpublishEntry(
        entryId: string,
        input: { actorId?: string; expectedVersion: number },
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        await this.#assertCanUnpublish(entryId)
        const guard = this.#combineGuards(
            this.#guard(entryId, input.expectedVersion),
            this.#unpublishGuard(entryId),
        )
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
                          version = version + 1, updated_at = ?
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
            throw new SiteAdminError(
                'SITE_ADMIN_INVALID_INPUT',
                'Scheduled publish time must be in the future.',
            )
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
        return result
    }

    async setSortOrder(
        entryId: string,
        sortOrder: number | null,
        expectedVersion: number,
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId)
        const definition = this.#model(entry.model)
        if (!definition.sortable) {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', `Model "${entry.model}" is not sortable.`)
        }
        if (sortOrder !== null && !Number.isFinite(sortOrder)) {
            throw new SiteAdminError(
                'SITE_ADMIN_INVALID_INPUT',
                'Sort order must be a finite number or null.',
            )
        }
        await this.#commit([
            {
                expectRow: true,
                params: [sortOrder, this.#now(), entryId, expectedVersion],
                query: true,
                sql: `UPDATE site_admin_entries SET sort_order = ?, version = version + 1, updated_at = ?
                      WHERE id = ? AND version = ? RETURNING version`,
            },
        ])
        return this.getEntry(entryId)
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
            throw new SiteAdminError(
                'SITE_ADMIN_RELATION_BLOCKED',
                'Retained revisions still reference this entry.',
            )
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

    async #publishedRows(modelName?: string, ids?: string[]): Promise<PublishedRow[]> {
        const conditions = ['e.published_revision_id IS NOT NULL']
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
        return queryRows<PublishedRow>(
            this.#options.database,
            `SELECT e.id, e.model, e.locale, r.id AS revision_id, r.data, r.slug
             FROM site_admin_entries e
             JOIN site_admin_revisions r ON r.id = e.published_revision_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY e.sort_order IS NULL, e.sort_order, e.updated_at DESC`,
            params,
        )
    }

    async #publishedGraph(roots: PublishedRow[]): Promise<Map<string, PublishedRow>> {
        const graph = new Map(roots.map((row) => [row.id, row]))
        let frontier = roots
        while (frontier.length > 0) {
            const nextIds = new Set<string>()
            for (const row of frontier) {
                const definition = this.config.models[row.model]
                if (!definition) continue
                const references = collectReferences(definition.fields, parseObject(row.data)).relations
                for (const reference of references) if (!graph.has(reference.id)) nextIds.add(reference.id)
            }
            if (nextIds.size === 0) break
            frontier = (await this.#publishedRows(undefined, [...nextIds])).filter(
                (row) => this.config.models[row.model]?.public !== false,
            )
            for (const row of frontier) graph.set(row.id, row)
        }
        return graph
    }

    #publicAsset(value: AssetInput): Record<string, unknown> {
        const reference = typeof value === 'string' ? { id: value } : { ...value }
        return {
            ...reference,
            url: `${this.#publicBase()}/_assets/${encodeURIComponent(reference.id)}`,
        }
    }

    #hydrateField(
        field: AnyField,
        value: unknown,
        graph: Map<string, PublishedRow>,
        trail: Set<string>,
    ): unknown {
        if (value === undefined || value === null) return value
        switch (field.kind) {
            case 'relation': {
                if (typeof value !== 'string') return null
                const target = graph.get(value)
                if (!target) return null
                return this.#projectPublished(target, graph, trail)
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
                )
            case 'array':
                return Array.isArray(value)
                    ? value.map((item) => this.#hydrateField(field.item, item, graph, trail))
                    : []
            case 'markdown':
                return typeof value === 'string'
                    ? value.replace(
                          /site-admin:\/\/asset\/([A-Za-z0-9_-]+)/gu,
                          (_, id: string) => `${this.#publicBase()}/_assets/${encodeURIComponent(id)}`,
                      )
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
    ): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(fields).map(([name, field]) => [
                name,
                this.#hydrateField(field, data[name], graph, trail),
            ]),
        )
    }

    #projectPublished(
        row: PublishedRow,
        graph: Map<string, PublishedRow>,
        parentTrail = new Set<string>(),
    ): PublicEntry {
        const definition = this.#model(row.model)
        const redirect = routeRedirect(definition, parseObject(row.data))
        const path =
            this.#options.routing?.enabled === false ||
            (redirect && this.#options.routing?.redirects === false)
                ? null
                : entryPath(row.model, definition, row.slug, this.#apiBases())
        if (parentTrail.has(row.id)) {
            return {
                data: {},
                id: row.id,
                locale: row.locale,
                model: row.model,
                path,
                revisionId: row.revision_id,
                slug: row.slug,
            }
        }
        const trail = new Set(parentTrail).add(row.id)
        return {
            data: this.#hydrateFields(definition.fields, parseObject(row.data), graph, trail),
            id: row.id,
            locale: row.locale,
            model: row.model,
            path,
            revisionId: row.revision_id,
            slug: row.slug,
        }
    }

    async listPublicEntries(modelName: string): Promise<PublicEntry[]> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false)
            throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const rows = await this.#publishedRows(modelName)
        const graph = await this.#publishedGraph(rows)
        return rows.map((row) => this.#projectPublished(row, graph))
    }

    async getPublicEntry(modelName: string, slugOrId: string): Promise<PublicEntry | null> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false)
            throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const row = await queryRow<PublishedRow>(
            this.#options.database,
            `SELECT e.id, e.model, e.locale, r.id AS revision_id, r.data, r.slug
             FROM site_admin_entries e
             JOIN site_admin_revisions r ON r.id = e.published_revision_id
             WHERE e.model = ? AND e.published_revision_id IS NOT NULL AND (r.slug = ? OR e.id = ?)
             LIMIT 1`,
            [modelName, slugOrId, slugOrId],
        )
        if (!row) return null
        return this.#projectPublished(row, await this.#publishedGraph([row]))
    }

    async publicGeneration(): Promise<number> {
        await this.initialize()
        const row = await queryRow<MetaRow>(
            this.#options.database,
            "SELECT value FROM site_admin_meta WHERE key = 'public_generation'",
        )
        return Number(row?.value ?? 0)
    }

    async content(modelName: string): Promise<ComarkContent> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false)
            throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const generation = await this.publicGeneration()
        const cached = this.#content.get(modelName)
        if (cached?.generation === generation) return cached.content
        const source: Source = {
            prefix: `/${modelName}`,
            schema: {
                ...fieldsSchema(definition.fields),
                properties: {
                    ...fieldsSchema(definition.fields).properties,
                    _siteAdmin: { type: 'object' },
                },
            },
            keys: async () =>
                (await this.#publishedRows(modelName)).map(
                    (row) => `${definition.route ? row.slug : row.id}.json`,
                ),
            getItem: async (key) => JSON.stringify(await this.#contentItem(modelName, key)),
            getItemRaw: async (key) => this.#contentItem(modelName, key),
        }
        const plugins = [...(this.config.markdown?.plugins ?? [])]
        if (this.config.markdown?.summary?.enabled !== false) {
            plugins.push(summary({ delimiter: this.config.markdown?.summary?.delimiter ?? '<!-- more -->' }))
        }
        const content = comarkContent({
            markdown: { plugins },
            onError: 'throw',
            plugins: [json(), markdownFields()],
            sources: { [modelName]: source },
        })
        this.#content.set(modelName, { content, generation })
        return content
    }

    async #contentItem(modelName: string, key: string): Promise<Record<string, unknown>> {
        const locator = key.replace(/\.json$/u, '')
        const entry = await this.getPublicEntry(modelName, locator)
        if (!entry)
            throw new SiteAdminError(
                'SITE_ADMIN_ENTRY_NOT_FOUND',
                `Public entry "${locator}" does not exist.`,
            )
        return {
            ...entry.data,
            _siteAdmin: {
                id: entry.id,
                locale: entry.locale,
                model: entry.model,
                path: entry.path,
                revisionId: entry.revisionId,
                slug: entry.slug,
            },
        }
    }

    async resolvePath(
        path: string,
    ): Promise<
        { entry: PublicEntry; kind: 'page' } | { kind: 'redirect'; status: number; target: string } | null
    > {
        await this.initialize()
        const generation = await this.publicGeneration()
        if (this.#routes?.generation !== generation) {
            const router = createRouter<RouteRow>()
            const routes = await queryRows<RouteRow>(
                this.#options.database,
                'SELECT * FROM site_admin_routes',
            )
            for (const route of routes) addRoute(router, 'GET', route.path, route)
            this.#routes = { generation, router }
        }
        const match = findRoute(this.#routes.router, 'GET', path, { normalize: true })
        if (!match) return null
        const route = match.data
        if (route.kind === 'page') {
            const row = await this.#publishedRows(undefined, [route.entry_id])
            const entry = row[0]
            return entry
                ? { entry: this.#projectPublished(entry, await this.#publishedGraph([entry])), kind: 'page' }
                : null
        }
        if (!route.target_path) return null
        return { kind: 'redirect', status: route.status ?? 302, target: route.target_path }
    }

    async sitemap(): Promise<Array<{ loc: string; lastmod?: string }>> {
        await this.initialize()
        const rows = await queryRows<{ path: string; updated_at: string }>(
            this.#options.database,
            `SELECT routes.path, entries.updated_at
             FROM site_admin_routes routes
             JOIN site_admin_entries entries ON entries.id = routes.entry_id
             WHERE routes.kind = 'page' ORDER BY routes.path`,
        )
        return rows.map((row) => ({ lastmod: row.updated_at, loc: row.path }))
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

    async llms(full = false): Promise<string> {
        await this.initialize()
        const lines = [`# ${this.#options.site?.name ?? 'Site content'}`, '', '> Published runtime content.']
        for (const [modelName, definition] of Object.entries(this.config.models)) {
            if (definition.public === false || !definition.route) continue
            if (typeof definition.route === 'object' && definition.route.redirect) continue
            const items = await (await this.content(modelName)).list(modelName)
            for (const item of items) {
                if (!isObject(item.data)) continue
                const metadata = item.data['_siteAdmin']
                if (!isObject(metadata)) continue
                const path = metadata.path
                if (typeof path !== 'string') continue
                const titleKeys = [definition.presentation?.title, 'title', 'name']
                const title =
                    titleKeys
                        .map((key) =>
                            key && typeof item.data[key] === 'string' ? cleanText(item.data[key]) : '',
                        )
                        .find(Boolean) || String(metadata.id ?? path)
                const documents: MarkdownDocumentValue[] = []
                for (const [name, field] of Object.entries(definition.fields)) {
                    collectMarkdown(field, item.data[name], documents)
                }
                const descriptionValue = definition.presentation?.description
                    ? item.data[definition.presentation.description]
                    : undefined
                const descriptionDocument = markdownDocument(descriptionValue) ?? documents[0]
                const description = cleanText(astText(descriptionDocument?.meta?.summary))
                let href = path
                if (this.#options.site?.url) {
                    try {
                        href = new URL(path, this.#options.site.url).href
                    } catch {}
                }
                lines.push('', `- [${title}](${href})${description ? ` — ${description.slice(0, 240)}` : ''}`)
                if (full) {
                    const body = cleanText(documents.map((document) => astText(document.nodes)).join(' '))
                    if (body) lines.push('', `## ${title}`, '', body)
                }
            }
        }
        return `${lines.join('\n')}\n`
    }

    async uploadAsset(input: UploadAssetInput): Promise<AssetRecord> {
        await this.initialize()
        const assets = this.config.assets
        if (!assets || !this.#options.getFiles) {
            throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        }
        const maxSize = assets.maxUploadSize ?? 10_000_000
        const bytes = await bytesFromBody(input.body, maxSize)
        if (bytes.byteLength === 0)
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Empty uploads are not accepted.')
        const id = this.#id()
        const key = `site-admin/${id}/${safeFilename(input.filename)}`
        const contentType = detectedMime(bytes, input.contentType)
        const time = this.#now()
        const hash = await checksum(bytes)
        await this.#commit([
            {
                params: [
                    id,
                    assets.storage,
                    key,
                    contentType,
                    bytes.byteLength,
                    hash,
                    JSON.stringify(input.metadata ?? {}),
                    'uploading',
                    time,
                    time,
                ],
                sql: `INSERT INTO site_admin_assets(
                    id, storage, key, content_type, size, checksum, metadata, state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            },
        ])
        try {
            const files = await this.#options.getFiles(assets.storage)
            const result = await files.upload(key, bytes, { contentType })
            if (Number(result.size) !== bytes.byteLength)
                throw new Error('Stored upload size does not match the request body.')
            await this.#commit([
                {
                    params: [result.contentType || contentType, result.size, this.#now(), id],
                    sql: `UPDATE site_admin_assets SET content_type = ?, size = ?, state = 'ready', updated_at = ?
                          WHERE id = ? AND state = 'uploading'`,
                },
            ])
        } catch (error) {
            await this.#commit([
                {
                    params: [this.#now(), id],
                    sql: "UPDATE site_admin_assets SET state = 'upload_failed', updated_at = ? WHERE id = ?",
                },
            ])
            throw error
        }
        return this.getAsset(id)
    }

    async getAsset(id: string): Promise<AssetRecord> {
        await this.initialize()
        const row = await queryRow<AssetRow>(
            this.#options.database,
            'SELECT * FROM site_admin_assets WHERE id = ?',
            [id],
        )
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
            const publicModels = Object.entries(this.config.models)
                .filter(([, definition]) => definition.public !== false)
                .map(([name]) => name)
            const published =
                publicModels.length === 0
                    ? undefined
                    : await queryRow<{ asset_id: string }>(
                          this.#options.database,
                          `SELECT refs.asset_id
                 FROM site_admin_asset_refs refs
                 JOIN site_admin_entries entries ON entries.published_revision_id = refs.revision_id
                 WHERE refs.asset_id = ? AND entries.model IN (${placeholders(publicModels.length)}) LIMIT 1`,
                          [id, ...publicModels],
                      )
            if (!published) throw new SiteAdminError('SITE_ADMIN_NOT_PUBLIC', `Asset "${id}" is not public.`)
        }
        if (!this.#options.getFiles) {
            throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        }
        const files = await this.#options.getFiles(asset.storage)
        return { asset, file: await files.download(asset.key) }
    }

    async deleteAsset(id: string): Promise<void> {
        await this.initialize()
        const asset = await this.getAsset(id)
        const reference = await queryRow<{ revision_id: string }>(
            this.#options.database,
            'SELECT revision_id FROM site_admin_asset_refs WHERE asset_id = ? LIMIT 1',
            [id],
        )
        if (reference)
            throw new SiteAdminError('SITE_ADMIN_ASSET_IN_USE', 'A retained revision still uses this Asset.')
        await this.#claimAsset(id)
        await this.#deleteClaimedAsset(asset)
    }

    async #claimAsset(id: string): Promise<void> {
        await this.#commit([
            {
                expectRow: true,
                params: [this.#now(), id],
                query: true,
                sql: `UPDATE site_admin_assets SET state = 'deleting', updated_at = ?
                      WHERE id = ? AND state IN ('ready', 'delete_failed', 'upload_failed')
                        AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs WHERE asset_id = site_admin_assets.id)
                      RETURNING id`,
            },
        ])
    }

    async #deleteClaimedAsset(asset: AssetRecord): Promise<void> {
        if (!this.#options.getFiles) {
            throw new SiteAdminError('SITE_ADMIN_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        }
        try {
            const files = await this.#options.getFiles(asset.storage)
            if (await files.exists(asset.key)) await files.delete(asset.key)
            await this.#commit([
                {
                    params: [this.#now(), asset.id],
                    sql: "UPDATE site_admin_assets SET state = 'deleted', updated_at = ? WHERE id = ? AND state = 'deleting'",
                },
            ])
        } catch (error) {
            await this.#commit([
                {
                    params: [this.#now(), asset.id],
                    sql: "UPDATE site_admin_assets SET state = 'delete_failed', updated_at = ? WHERE id = ? AND state = 'deleting'",
                },
            ])
            throw error
        }
    }

    async runAssetGC(): Promise<{ deleted: string[]; failed: Array<{ id: string; message: string }> }> {
        await this.initialize()
        if (!this.config.assets) return { deleted: [], failed: [] }
        const grace = durationMilliseconds(this.config.assets.orphanGracePeriod ?? '24h')
        const cutoff = new Date(this.#date().getTime() - grace).toISOString()
        const candidates = await queryRows<AssetRow>(
            this.#options.database,
            `SELECT assets.* FROM site_admin_assets assets
             WHERE assets.state IN ('ready', 'delete_failed', 'upload_failed') AND assets.created_at <= ?
               AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs refs WHERE refs.asset_id = assets.id)`,
            [cutoff],
        )
        const result: { deleted: string[]; failed: Array<{ id: string; message: string }> } = {
            deleted: [],
            failed: [],
        }
        for (const row of candidates) {
            const asset = toAsset(row)
            try {
                await this.#claimAsset(asset.id)
                await this.#deleteClaimedAsset(asset)
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

    #publicBase(): string {
        return (this.#options.publicBase ?? '/api/content').replace(/\/$/u, '')
    }

    #apiBases(): string[] {
        return [this.#publicBase(), (this.#options.managementBase ?? '/api/site-admin').replace(/\/$/u, '')]
    }
}

export const createSiteAdmin = (options: SiteAdminOptions): SiteAdmin => new SiteAdmin(options)
