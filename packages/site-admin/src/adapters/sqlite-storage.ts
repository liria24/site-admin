import type { DrizzleConnection } from './database'
import type { SiteAdminConfig } from '../config'
import type { AtomicStatement, DatabaseValue } from './sqlite-statements'
import type { AssetRecord, EntryRecord, RevisionRecord } from '../server/types'
import type {
    StorageAssets,
    StorageContent,
    StorageCondition,
    StoragePublishedEntry,
    StorageAssetCopyGuard,
    StorageAssetSyncLease,
    StorageRoute,
    StorageEntryFilter,
} from '../storage'
import { SiteAdminError } from '../errors'
import { searchQuery } from '../storage'
import { queryRows, runAtomic } from './drizzle-database'
import { revisionSource } from './drizzle-tables'
import { projectStoredFields } from '../stored-data'
import { createSiteAdminDescriptor } from '../descriptor'
import { translatedRouteFields } from '../i18n'
import { searchRecords, searchPredicate } from './sqlite-search'

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(',')
const decodeObject = (value: string): Record<string, unknown> => {
    const result: unknown = JSON.parse(value)
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', 'Stored revision data is not an object.')
    return result as Record<string, unknown>
}
const translationColumns =
    "COALESCE((SELECT json_group_object(t.locale,json(t.data)) FROM site_admin_translations t WHERE t.revision_id=r.id),'{}') AS translations"
const entryColumns = `e.id, e.model, e.default_locale AS defaultLocale, e.current_revision_id AS currentRevisionId,
    e.published_revision_id AS publishedRevisionId, e.scheduled_revision_id AS scheduledRevisionId, e.scheduled_at AS scheduledAt,
    e.sort_order AS sortOrder, e.version, e.created_at AS createdAt, e.updated_at AS updatedAt, e.published_at AS publishedAt,
    r.id AS revisionId, r.data, ${translationColumns}`
const publishedColumns = `e.id, e.model, e.default_locale AS defaultLocale, e.published_at AS publishedAt, r.id AS revisionId, r.data, ${translationColumns}`
const assetColumns = `id, storage, key, content_type AS contentType, size, checksum, metadata, state,
    operation_token AS operationToken, lease_expires_at AS leaseExpiresAt, created_at AS createdAt, updated_at AS updatedAt`
type StoredEntry = Omit<EntryRecord, 'data' | 'translations'> & { data: string; translations: string }
type StoredRevision = Omit<RevisionRecord, 'data' | 'translations'> & { data: string; translations: string }
type StoredPublished = Omit<StoragePublishedEntry, 'data' | 'translations'> & { data: string; translations: string }
type StoredAsset = Omit<AssetRecord, 'metadata'> & { metadata: string }
const entry = (row: StoredEntry): EntryRecord => ({
    ...row,
    data: decodeObject(row.data),
    translations: JSON.parse(row.translations),
    version: Number(row.version),
    locale: row.defaultLocale,
})
const revision = (row: StoredRevision): RevisionRecord => ({
    ...row,
    data: decodeObject(row.data),
    translations: JSON.parse(row.translations),
})
const published = (row: StoredPublished): StoragePublishedEntry => ({
    ...row,
    locale: row.defaultLocale,
    data: decodeObject(row.data),
    translations: JSON.parse(row.translations),
})
const asset = (row: StoredAsset): AssetRecord => ({
    ...row,
    metadata: decodeObject(row.metadata) as Record<string, string>,
    size: Number(row.size),
})
const patchColumns = {
    currentRevisionId: 'current_revision_id',
    publishedRevisionId: 'published_revision_id',
    scheduledRevisionId: 'scheduled_revision_id',
    scheduledAt: 'scheduled_at',
    publishedAt: 'published_at',
    sortOrder: 'sort_order',
    updatedAt: 'updated_at',
} as const

/** SQLite physical codec, reads and conditional batch compiler. Core only supplies semantic candidates. */
export const sqliteStorage = (
    database: DrizzleConnection,
    config: SiteAdminConfig,
    insertRevisionData: (model: string, id: string, data: Record<string, unknown>) => AtomicStatement,
): StorageContent & StorageAssets => {
    const source = revisionSource(config)
    const routeFields = Object.fromEntries(
        Object.entries(config.models).map(([name, definition]) => [name, translatedRouteFields(definition)]),
    )
    const selectedPublishedColumns = (locale?: string) =>
        locale === undefined
            ? publishedColumns
            : publishedColumns.replace('t.revision_id=r.id', 't.revision_id=r.id AND t.locale=?')
    const fingerprints = Object.fromEntries(
        Object.entries(createSiteAdminDescriptor(config).models).map(([model, definition]) => [
            model,
            JSON.stringify(definition.fields),
        ]),
    )
    const recordsFor = (
        model: string,
        data: Record<string, unknown>,
        locale: string,
        translations: import('../i18n').Translations,
    ) => {
        const fields = config.models[model]!.fields
        return [locale, ...Object.keys(translations)].flatMap((language) => [
            { locale: language, part: -1, value: fingerprints[model]! },
            ...searchRecords(projectStoredFields(fields, { ...data, ...translations[language] }), language, {}),
        ])
    }
    const rows = <Row extends object>(sql: string, params: DatabaseValue[] = []) =>
        queryRows<Row>(database, sql, params)
    const row = async <Row extends object>(sql: string, params: DatabaseValue[] = []) =>
        (await rows<Row>(sql, params))[0]
    const execute = async (statements: AtomicStatement[]) => {
        try {
            return await runAtomic(database, statements)
        } catch (error) {
            if (
                !(error instanceof SiteAdminError) &&
                error instanceof Error &&
                /site_admin_routes(?:\.path)?/iu.test(error.message)
            )
                throw new SiteAdminError('SITE_ADMIN_ROUTE_CONFLICT', 'Another public route already owns this path.')
            throw error
        }
    }
    const changed = async (sql: string, params: DatabaseValue[]) =>
        (await execute([{ sql, params, query: true }]))[0]!.rows.length > 0
    const conditions = (values: readonly StorageCondition[] = []) => {
        const clauses: string[] = [],
            params: DatabaseValue[] = []
        const versions = values.filter((value) => value.kind === 'entryVersion')
        if (versions.length) {
            clauses.push(
                "NOT EXISTS (SELECT 1 FROM json_each(?) candidate LEFT JOIN site_admin_entries e ON e.id=json_extract(candidate.value,'$.id') WHERE e.id IS NULL OR json_extract(candidate.value,'$.version') IS NOT e.version OR (json_type(candidate.value,'$.model') IS NOT NULL AND json_extract(candidate.value,'$.model') IS NOT e.model))",
            )
            params.push(JSON.stringify(versions))
        }
        for (const value of values) {
            switch (value.kind) {
                case 'entryVersion':
                    break
                case 'publicGeneration':
                    clauses.push(
                        "CAST(COALESCE((SELECT value FROM site_admin_meta WHERE key='public_generation'),'0') AS INTEGER)=?",
                    )
                    params.push(value.generation)
                    break
                case 'assetsReady':
                    if (value.ids.length) {
                        clauses.push(
                            "NOT EXISTS (SELECT 1 FROM json_each(?) candidate LEFT JOIN site_admin_assets a ON a.id=candidate.value WHERE a.state IS NOT 'ready')",
                        )
                        params.push(JSON.stringify(value.ids))
                    }
                    break
                case 'relations':
                    if (value.targets.length) {
                        clauses.push(
                            "NOT EXISTS (SELECT 1 FROM json_each(?) candidate LEFT JOIN site_admin_entries e ON e.id=json_extract(candidate.value,'$.id') WHERE e.id IS NULL OR e.model IS NOT json_extract(candidate.value,'$.model') OR (json_extract(candidate.value,'$.published')=1 AND e.published_revision_id IS NULL))",
                        )
                        params.push(JSON.stringify(value.targets))
                    }
                    break
                case 'noRequiredPublicReferences':
                    if (value.models.length) {
                        clauses.push(
                            'NOT EXISTS (SELECT 1 FROM site_admin_relations rel JOIN site_admin_entries e ON e.published_revision_id=rel.revision_id WHERE rel.target_entry_id=? AND e.id<>? AND rel.required=1 AND e.model IN (SELECT value FROM json_each(?)))',
                        )
                        params.push(value.id, value.id, JSON.stringify(value.models))
                    }
                    break
                case 'noRetainedRelations':
                    clauses.push('NOT EXISTS (SELECT 1 FROM site_admin_relations WHERE target_entry_id=?)')
                    params.push(value.id)
                    break
            }
        }
        return { clause: clauses.length ? clauses.map((value) => '(' + value + ')').join(' AND ') : '1', params }
    }

    const entryFilter = (filter: Parameters<StorageContent['entries']>[0] = {}) => {
        const clauses: string[] = [],
            params: DatabaseValue[] = []
        const models = filter.models ?? Object.keys(config.models)
        if (!models.length) clauses.push('0')
        else {
            clauses.push('e.model IN (SELECT value FROM json_each(?))')
            params.push(JSON.stringify(models))
        }
        if (filter.q) {
            const q = filter.q
            const data = searchPredicate(q)
            clauses.push(data.sql)
            params.push(filter.locale ?? '', data.length, q)
        }
        return { sql: clauses.join(' AND '), params }
    }
    const contentFrom = `FROM site_admin_entries e JOIN ${source} r ON r.id=e.current_revision_id`
    const readContent = async (
        filter: StorageEntryFilter,
        statements: (from: string, params: DatabaseValue[]) => AtomicStatement[],
    ) => {
        const q = searchQuery(filter.q)
        filter = { ...filter, ...(q === undefined ? {} : { q }) }
        const where = entryFilter(filter)
        const checks: AtomicStatement[] = q
            ? [
                  {
                      sql: `SELECT 1 FROM site_admin_entries e JOIN json_each(?) fingerprint ON fingerprint.key=e.model
                WHERE e.model IN (SELECT value FROM json_each(?)) AND (
                  NOT EXISTS (SELECT 1 FROM site_admin_search s WHERE s.revision_id=e.current_revision_id AND s.locale=e.default_locale AND s.part=-1 AND s.value=fingerprint.value)
                  OR EXISTS (SELECT 1 FROM site_admin_translations t WHERE t.revision_id=e.current_revision_id AND NOT EXISTS
                    (SELECT 1 FROM site_admin_search s WHERE s.revision_id=t.revision_id AND s.locale=t.locale AND s.part=-1 AND s.value=fingerprint.value))) LIMIT 1`,
                      params: [
                          JSON.stringify(fingerprints),
                          JSON.stringify(filter.models ?? Object.keys(config.models)),
                      ],
                      query: true,
                  },
              ]
            : []
        const result = await execute([...checks, ...statements(`${contentFrom} WHERE ${where.sql}`, where.params)])
        if (q && result.shift()!.rows.length)
            throw new SiteAdminError(
                'SITE_ADMIN_MIGRATION_REQUIRED',
                'Rebuild the search index explicitly before searching.',
            )
        return result
    }
    const leaseValue = (lease: StorageAssetSyncLease) => `${lease.expiresAt}|${lease.id}`
    const copyGuard = (guard?: StorageAssetCopyGuard) => {
        if (!guard) return { clause: '1', params: [] as DatabaseValue[] }
        return {
            clause: `EXISTS (SELECT 1 FROM site_admin_meta WHERE key='asset_sync_lease' AND value=? AND value>?)${guard.generation === undefined ? '' : " AND CAST(COALESCE((SELECT value FROM site_admin_meta WHERE key='public_generation'),'0') AS INTEGER)=?"}`,
            params: [
                leaseValue(guard.lease),
                `${guard.now}|~`,
                ...(guard.generation === undefined ? [] : [guard.generation]),
            ] as DatabaseValue[],
        }
    }
    return {
        readEntry: async (id) => {
            const value = await row<StoredEntry>(
                `SELECT ${entryColumns} FROM site_admin_entries e JOIN ${source} r ON r.id=e.current_revision_id WHERE e.id=?`,
                [id],
            )
            return value && entry(value)
        },
        entries: async (filter) => {
            const result = await readContent(filter ?? {}, (from, params) => [
                {
                    sql: `SELECT ${entryColumns} ${from} ORDER BY e.sort_order IS NULL,e.sort_order,e.updated_at DESC,e.id`,
                    params,
                    query: true,
                },
            ])
            return (result[0]!.rows as StoredEntry[]).map(entry)
        },
        pageEntries: async (filter, page) => {
            const results = await readContent(filter, (from, params) => [
                { sql: `SELECT COUNT(*) AS total ${from}`, params, query: true },
                {
                    sql: `SELECT ${entryColumns} ${from} ORDER BY e.sort_order IS NULL,e.sort_order,e.updated_at DESC,e.id LIMIT ? OFFSET ?`,
                    params: [...params, page.limit, page.offset],
                    query: true,
                },
            ])
            return {
                items: (results[1]!.rows as StoredEntry[]).map(entry),
                total: Number((results[0]!.rows[0] as { total: number }).total),
            }
        },
        readRevision: async (id, entryId) => {
            const value = await row<StoredRevision>(
                `SELECT r.id,r.entry_id AS entryId,r.actor_id AS actorId,r.created_at AS createdAt,r.data,${translationColumns} FROM ${source} r WHERE r.id=?${entryId === undefined ? '' : ' AND entry_id=?'}`,
                entryId === undefined ? [id] : [id, entryId],
            )
            return value && revision(value)
        },
        revisions: async (entryId) =>
            (
                await rows<StoredRevision>(
                    `SELECT r.id,r.entry_id AS entryId,r.actor_id AS actorId,r.created_at AS createdAt,r.data,${translationColumns} FROM ${source} r WHERE entry_id=? ORDER BY created_at DESC`,
                    [entryId],
                )
            ).map(revision),
        revisionIds: async (entryId) =>
            (
                await rows<{ id: string }>(
                    'SELECT id FROM site_admin_revisions WHERE entry_id=? ORDER BY created_at DESC,id DESC',
                    [entryId],
                )
            ).map(({ id }) => id),
        pruneRevisions: async (entryId, candidates) => {
            if (!candidates.length) return []
            const protectedRevision = (expression: string) =>
                `NOT EXISTS (SELECT 1 FROM site_admin_entries e WHERE e.id=? AND (e.current_revision_id=${expression} OR e.published_revision_id=${expression} OR e.scheduled_revision_id=${expression})) AND NOT EXISTS (SELECT 1 FROM site_admin_routes route WHERE route.revision_id=${expression})`
            const result = await execute([
                ...['site_admin_asset_refs', 'site_admin_relations'].map((table) => ({
                    sql: `DELETE FROM ${table} WHERE revision_id IN (SELECT value FROM json_each(?)) AND ${protectedRevision(`${table}.revision_id`)}`,
                    params: [JSON.stringify(candidates), entryId],
                })),
                {
                    sql: `DELETE FROM site_admin_revisions AS r WHERE entry_id=? AND id IN (SELECT value FROM json_each(?)) AND ${protectedRevision('r.id')} RETURNING id`,
                    params: [entryId, JSON.stringify(candidates), entryId],
                    query: true,
                },
            ])
            return (result.at(-1)!.rows as Array<{ id: string }>).map(({ id }) => id)
        },
        referenceTargets: async (ids) =>
            ids.length
                ? rows(
                      `SELECT id,model,published_revision_id AS publishedRevisionId FROM site_admin_entries WHERE id IN (SELECT value FROM json_each(?))`,
                      [JSON.stringify(ids)],
                  )
                : [],
        incomingReferences: async (id, options) => {
            const clauses = ['rel.target_entry_id=?'],
                params: DatabaseValue[] = [options.view, id]
            if (options.from) {
                clauses.push('e.model=?')
                params.push(options.from)
            }
            if (options.field) {
                clauses.push('rel.field_path=?')
                params.push(options.field)
            }
            if (options.required) clauses.push('rel.required=1')
            if (options.excludeSelf) {
                clauses.push('e.id<>?')
                params.push(id)
            }
            return rows(
                `SELECT e.id AS entryId,e.model,rel.revision_id AS revisionId,rel.field_path AS field,? AS view FROM site_admin_relations rel JOIN site_admin_entries e ON e.${options.view === 'published' ? 'published_revision_id' : 'current_revision_id'}=rel.revision_id WHERE ${clauses.join(' AND ')} ORDER BY e.model,e.id,rel.field_path`,
                params,
            )
        },
        hasRetainedRelations: async (id) =>
            Boolean(await row('SELECT 1 FROM site_admin_relations WHERE target_entry_id=? LIMIT 1', [id])),
        published: async (filter = {}) => {
            const clauses = ['e.published_revision_id IS NOT NULL', 'e.published_at IS NOT NULL'],
                params: DatabaseValue[] = []
            if (filter.model) {
                clauses.push('e.model=?')
                params.push(filter.model)
            }
            for (const [column, values] of [['e.id', filter.ids]] as const) {
                if (values === undefined) continue
                if (!values.length) return []
                clauses.push(`${column} IN (SELECT value FROM json_each(?))`)
                params.push(JSON.stringify(values))
            }
            return (
                await rows<StoredPublished>(
                    `SELECT ${selectedPublishedColumns(filter.locale)} FROM site_admin_entries e JOIN ${source} r ON r.id=e.published_revision_id WHERE ${clauses.join(' AND ')} ORDER BY e.sort_order IS NULL,e.sort_order,e.published_at DESC,e.id`,
                    [...(filter.locale === undefined ? [] : [filter.locale]), ...params],
                )
            ).map(published)
        },
        pagePublished: async (filter, page) => {
            const from = `FROM site_admin_entries e JOIN ${source} r ON r.id=e.published_revision_id WHERE e.model=? AND e.published_revision_id IS NOT NULL AND e.published_at IS NOT NULL`
            const result = await execute([
                { sql: `SELECT COUNT(*) AS total ${from}`, params: [filter.model], query: true },
                {
                    sql: `SELECT ${selectedPublishedColumns(filter.locale)} ${from} ORDER BY e.sort_order IS NULL,e.sort_order,e.published_at DESC,e.id LIMIT ? OFFSET ?`,
                    params: [
                        ...(filter.locale === undefined ? [] : [filter.locale]),
                        filter.model,
                        page.limit,
                        page.offset,
                    ],
                    query: true,
                },
            ])
            return {
                items: (result[1]!.rows as StoredPublished[]).map(published),
                total: Number((result[0]!.rows[0] as { total: number }).total),
            }
        },
        publicTranslations: async (ids) => {
            if (!ids.length) return []
            const values = await rows<{
                entryId: string
                locale: string
                data: string
                assets: string
                relations: string
            }>(
                `SELECT e.id AS entryId,t.locale,
                COALESCE((SELECT json_group_object(j.key,j.value) FROM json_each(t.data) j WHERE j.key IN (SELECT value FROM json_each(json_extract(?, '$.'||e.model)))),'{}') AS data,
                COALESCE((SELECT json_group_array(json_object('id',a.asset_id,'path',a.field_path,'position',a.position)) FROM site_admin_asset_refs a WHERE a.revision_id=t.revision_id AND a.locale=t.locale),'[]') AS assets,
                COALESCE((SELECT json_group_array(json_object('id',rel.target_entry_id,'path',rel.field_path,'position',rel.position)) FROM site_admin_relations rel WHERE rel.revision_id=t.revision_id AND rel.locale=t.locale),'[]') AS relations
                FROM site_admin_entries e JOIN site_admin_translations t ON t.revision_id=e.published_revision_id WHERE e.id IN (SELECT value FROM json_each(?))`,
                [JSON.stringify(routeFields), JSON.stringify(ids)],
            )
            return values.map((value) => ({
                ...value,
                data: decodeObject(value.data),
                assets: JSON.parse(value.assets),
                relations: JSON.parse(value.relations),
            }))
        },
        rebuildSearch: async () => {
            let after = '',
                indexed = 0
            while (true) {
                const candidates = await rows<StoredRevision & { defaultLocale: string; model: string }>(
                    `SELECT r.id,r.data,e.model,e.default_locale AS defaultLocale,${translationColumns} FROM ${source} r JOIN site_admin_entries e ON e.id=r.entry_id WHERE r.id>? ORDER BY r.id LIMIT 8`,
                    [after],
                )
                if (!candidates.length) return { indexed }
                for (const value of candidates) {
                    const records = recordsFor(
                        value.model,
                        decodeObject(value.data),
                        value.defaultLocale,
                        JSON.parse(value.translations),
                    )
                    await execute([
                        { sql: 'DELETE FROM site_admin_search WHERE revision_id=?', params: [value.id] },
                        ...records.map((record) => ({
                            sql: 'INSERT INTO site_admin_search(revision_id,locale,part,value) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM site_admin_revisions WHERE id=?) ON CONFLICT(revision_id,locale,part) DO UPDATE SET value=excluded.value',
                            params: [value.id, record.locale, record.part, record.value, value.id],
                        })),
                    ])
                    after = value.id
                    indexed++
                }
            }
        },
        routes: async (filter = {}) => {
            const clauses: string[] = [],
                params: DatabaseValue[] = []
            for (const [column, value] of [
                ['entry_id', filter.entryId],
                ['path', filter.path],
            ] as const)
                if (value !== undefined) {
                    clauses.push(`${column}=?`)
                    params.push(value)
                }
            if (filter.locales) {
                if (!filter.locales.length) return []
                clauses.push('locale IN (SELECT value FROM json_each(?))')
                params.push(JSON.stringify(filter.locales))
            }
            if (filter.kinds) {
                if (!filter.kinds.length) return []
                clauses.push(`kind IN (${placeholders(filter.kinds.length)})`)
                params.push(...filter.kinds)
            }
            return rows<StorageRoute>(
                `SELECT entry_id AS entryId,revision_id AS revisionId,kind,locale,path,status,target_path AS targetPath,created_at AS createdAt FROM site_admin_routes${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY locale,path`,
                params,
            )
        },
        scheduledBefore: async (now) =>
            rows(
                'SELECT id,scheduled_revision_id AS revisionId,version FROM site_admin_entries WHERE scheduled_revision_id IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at',
                [now],
            ),
        publicGeneration: async () =>
            Number(
                (await row<{ value: string }>("SELECT value FROM site_admin_meta WHERE key='public_generation'"))
                    ?.value ?? 0,
            ),
        commit: async (input) => {
            const precondition = conditions(input.conditions),
                statements: AtomicStatement[] = []
            const targetIds = [...(input.updates ?? []).map(({ id }) => id), ...(input.delete ? [input.delete] : [])]
            if (targetIds.length) {
                precondition.clause +=
                    ' AND NOT EXISTS (SELECT 1 FROM json_each(?) candidate LEFT JOIN site_admin_entries e ON e.id=candidate.value WHERE e.id IS NULL)'
                precondition.params.push(JSON.stringify(targetIds))
            }
            // One batch-local witness fixes every condition to the pre-commit state, including
            // guards whose entries are subsequently updated/deleted. The native transaction
            // isolates this row; successful batches remove it and failed batches roll it back.
            const witness = 'content_commit:' + crypto.randomUUID()
            const guard = { clause: 'EXISTS (SELECT 1 FROM site_admin_meta WHERE key=?)', params: [witness] }
            const gated = (sql: string, params: DatabaseValue[], returning = false): AtomicStatement => ({
                sql: `${sql} WHERE ${guard.clause}${returning ? ' RETURNING id' : ''}`,
                params: [...params, ...guard.params],
                ...(returning ? { query: true, expectRow: true } : {}),
            })
            // D1 batches cannot throw on an empty RETURNING result before commit. Gate every dependent write.
            statements.push({
                sql: `INSERT INTO site_admin_meta(key,value) SELECT ?,'1' WHERE ${precondition.clause} RETURNING key`,
                params: [witness, ...precondition.params],
                query: true,
                expectRow: true,
            })
            if (input.create) {
                const value = input.create
                statements.push(
                    gated(
                        'INSERT INTO site_admin_entries(id,model,default_locale,current_revision_id,published_revision_id,scheduled_revision_id,scheduled_at,sort_order,version,created_at,updated_at,published_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?',
                        [
                            value.id,
                            value.model,
                            value.defaultLocale,
                            value.currentRevisionId,
                            value.publishedRevisionId,
                            value.scheduledRevisionId,
                            value.scheduledAt,
                            value.sortOrder,
                            value.version,
                            value.createdAt,
                            value.updatedAt,
                            value.publishedAt,
                        ],
                        true,
                    ),
                )
            }
            for (const value of input.revisions ?? []) {
                statements.push(
                    gated('INSERT INTO site_admin_revisions(id,entry_id,actor_id,created_at) SELECT ?,?,?,?', [
                        value.id,
                        value.entryId,
                        value.actorId,
                        value.createdAt,
                    ]),
                )
                const data = insertRevisionData(value.model, value.id, value.data)
                statements.push({
                    ...data,
                    sql: `${data.sql} AND ${guard.clause}`,
                    params: [...(data.params ?? []), ...guard.params],
                })
                for (const [locale, translation] of Object.entries(value.translations))
                    statements.push(
                        gated('INSERT INTO site_admin_translations(revision_id,locale,data) SELECT ?,?,?', [
                            value.id,
                            locale,
                            JSON.stringify(translation),
                        ]),
                    )
                const original =
                    input.create?.id === value.entryId
                        ? input.create
                        : await row<{ defaultLocale: string }>(
                              'SELECT default_locale AS defaultLocale FROM site_admin_entries WHERE id=?',
                              [value.entryId],
                          )
                for (const record of recordsFor(
                    value.model,
                    value.data,
                    original?.defaultLocale ?? '',
                    value.translations,
                ))
                    statements.push(
                        gated('INSERT INTO site_admin_search(revision_id,locale,part,value) SELECT ?,?,?,?', [
                            value.id,
                            record.locale,
                            record.part,
                            record.value,
                        ]),
                    )
                for (const ref of value.relations)
                    statements.push(
                        gated(
                            'INSERT INTO site_admin_relations(revision_id,locale,field_path,target_entry_id,position,required) SELECT ?,?,?,?,?,?',
                            [value.id, ref.locale ?? '', ref.path, ref.id, ref.position, ref.required ? 1 : 0],
                        ),
                    )
                for (const ref of value.assets)
                    statements.push(
                        gated(
                            'INSERT INTO site_admin_asset_refs(revision_id,locale,field_path,asset_id,position) SELECT ?,?,?,?,?',
                            [value.id, ref.locale ?? '', ref.path, ref.id, ref.position],
                        ),
                    )
            }
            for (const change of input.routes ?? []) {
                if (change.kind === 'put') {
                    const value = change.route
                    statements.push(
                        gated(
                            'INSERT INTO site_admin_routes(path,locale,entry_id,revision_id,kind,target_path,status,created_at) SELECT ?,?,?,?,?,?,?,?',
                            [
                                value.path,
                                value.locale,
                                value.entryId,
                                value.revisionId,
                                value.kind,
                                value.targetPath,
                                value.status,
                                value.createdAt,
                            ],
                        ),
                    )
                } else if (change.kind === 'retargetHistory')
                    statements.push({
                        sql: `UPDATE site_admin_routes SET target_path=?,status=? WHERE entry_id=? AND kind='historical' ${change.locale === undefined ? '' : 'AND locale=?'} AND ${guard.clause}`,
                        params: [
                            change.path,
                            change.status,
                            change.entryId,
                            ...(change.locale === undefined ? [] : [change.locale]),
                            ...guard.params,
                        ],
                    })
                else {
                    const clauses = ['entry_id=?'],
                        params: DatabaseValue[] = [change.entryId]
                    if (change.locale !== undefined) {
                        clauses.push('locale=?')
                        params.push(change.locale)
                    }
                    if (change.path !== undefined) {
                        clauses.push('path=?')
                        params.push(change.path)
                    }
                    if (change.kinds) {
                        if (!change.kinds.length) continue
                        clauses.push(`kind IN (${placeholders(change.kinds.length)})`)
                        params.push(...change.kinds)
                    }
                    statements.push({
                        sql: `DELETE FROM site_admin_routes WHERE ${clauses.join(' AND ')} AND ${guard.clause}`,
                        params: [...params, ...guard.params],
                    })
                }
            }
            if (input.delete) {
                statements.push(
                    ...['site_admin_asset_refs', 'site_admin_relations'].map((table) => ({
                        sql: `DELETE FROM ${table} WHERE revision_id IN (SELECT id FROM site_admin_revisions WHERE entry_id=?) AND ${guard.clause}`,
                        params: [input.delete!, ...guard.params],
                    })),
                )
                statements.push({
                    sql: `DELETE FROM site_admin_revisions WHERE entry_id=? AND ${guard.clause}`,
                    params: [input.delete, ...guard.params],
                })
            }
            if (input.publicGeneration)
                statements.push({
                    sql: `INSERT INTO site_admin_meta(key,value) SELECT 'public_generation','1' WHERE ${guard.clause} ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`,
                    params: guard.params,
                })
            if (input.updates?.length) {
                const keys = Object.keys(patchColumns).filter((key) =>
                    input.updates!.some(({ patch }) => Object.hasOwn(patch, key)),
                ) as Array<keyof typeof patchColumns>
                const changes = keys.map(
                    (key) =>
                        `${patchColumns[key]}=CASE WHEN json_type((SELECT patch FROM candidates WHERE candidates.id=site_admin_entries.id),'$.${key}') IS NULL THEN ${patchColumns[key]} ELSE json_extract((SELECT patch FROM candidates WHERE candidates.id=site_admin_entries.id),'$.${key}') END`,
                )
                statements.push({
                    sql: `WITH valid(ok) AS MATERIALIZED (SELECT ${guard.clause}), candidates AS MATERIALIZED (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.patch') AS patch FROM json_each(?)) UPDATE site_admin_entries SET ${[...changes, 'version=version+1'].join(',')} WHERE (SELECT ok FROM valid) AND id IN (SELECT id FROM candidates) RETURNING id`,
                    params: [...guard.params, JSON.stringify(input.updates)],
                    query: true,
                    expectRow: true,
                })
            }
            if (input.delete)
                statements.push({
                    sql: `DELETE FROM site_admin_entries WHERE id=? AND ${guard.clause} RETURNING id`,
                    params: [input.delete, ...guard.params],
                    query: true,
                    expectRow: true,
                })
            for (const id of input.prune ?? []) {
                const unused = `SELECT r.id FROM site_admin_revisions r WHERE r.entry_id=? AND NOT EXISTS (SELECT 1 FROM site_admin_entries e WHERE e.id=r.entry_id AND (e.current_revision_id=r.id OR e.published_revision_id=r.id OR e.scheduled_revision_id=r.id)) AND NOT EXISTS (SELECT 1 FROM site_admin_routes route WHERE route.revision_id=r.id)`
                for (const table of ['site_admin_asset_refs', 'site_admin_relations'])
                    statements.push({
                        sql: `DELETE FROM ${table} WHERE revision_id IN (${unused}) AND ${guard.clause}`,
                        params: [id, ...guard.params],
                    })
                statements.push()
                statements.push({
                    sql: `DELETE FROM site_admin_revisions WHERE id IN (${unused}) AND ${guard.clause}`,
                    params: [id, ...guard.params],
                })
            }
            statements.push({ sql: 'DELETE FROM site_admin_meta WHERE key=?', params: [witness] })
            await execute(statements)
        },
        readAsset: async (id) => {
            const value = await row<StoredAsset>(`SELECT ${assetColumns} FROM site_admin_assets WHERE id=?`, [id])
            return value && asset(value)
        },
        assets: async (filter = {}) => {
            const clauses: string[] = [],
                params: DatabaseValue[] = []
            if (filter.ids) {
                if (!filter.ids.length) return []
                clauses.push('id IN (SELECT value FROM json_each(?))')
                params.push(JSON.stringify(filter.ids))
            }
            if (filter.state !== undefined) {
                clauses.push('state=?')
                params.push(filter.state)
            }
            if (filter.storage !== undefined) {
                clauses.push('storage=?')
                params.push(filter.storage)
            }
            return (
                await rows<StoredAsset>(
                    `SELECT ${assetColumns} FROM site_admin_assets${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`,
                    params,
                )
            ).map(asset)
        },
        assetGCCandidates: async (cutoff, now) =>
            (
                await rows<StoredAsset>(
                    `SELECT ${assetColumns} FROM site_admin_assets WHERE ((state IN ('ready','delete_failed','upload_failed') AND created_at<=?) OR (state IN ('uploading','deleting') AND lease_expires_at<=?)) AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs refs WHERE refs.asset_id=site_admin_assets.id)`,
                    [cutoff, now],
                )
            ).map(asset),
        hasAssetReferences: async (id) =>
            Boolean(await row('SELECT 1 FROM site_admin_asset_refs WHERE asset_id=? LIMIT 1', [id])),
        publishedAssetSources: async (id) =>
            (
                await rows<{ id: string }>(
                    'SELECT e.id FROM site_admin_asset_refs refs JOIN site_admin_entries e ON e.published_revision_id=refs.revision_id WHERE refs.asset_id=?',
                    [id],
                )
            ).map(({ id: entryId }) => entryId),
        insertAsset: async (value) => {
            await execute([
                {
                    sql: 'INSERT INTO site_admin_assets(id,storage,key,content_type,size,checksum,metadata,state,operation_token,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    params: [
                        value.id,
                        value.storage,
                        value.key,
                        value.contentType,
                        value.size,
                        value.checksum,
                        JSON.stringify(value.metadata),
                        value.state,
                        value.operationToken,
                        value.leaseExpiresAt,
                        value.createdAt,
                        value.updatedAt,
                    ],
                },
            ])
        },
        finishAssetUpload: (id, token, ready, now) =>
            ready
                ? changed(
                      "UPDATE site_admin_assets SET content_type=?,size=?,checksum=?,state='ready',operation_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='uploading' AND operation_token=? RETURNING id",
                      [ready.contentType, ready.size, ready.checksum, now, id, token],
                  )
                : changed(
                      "UPDATE site_admin_assets SET state='upload_failed',operation_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='uploading' AND operation_token=? RETURNING id",
                      [now, id, token],
                  ),
        claimAssetDeletion: (id, token, expiresAt, now) =>
            changed(
                "UPDATE site_admin_assets SET state='deleting',operation_token=?,lease_expires_at=?,updated_at=? WHERE id=? AND (state IN ('ready','delete_failed','upload_failed') OR (state IN ('uploading','deleting') AND lease_expires_at<=?)) AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs WHERE asset_id=site_admin_assets.id) RETURNING id",
                [token, expiresAt, now, id, now],
            ),
        finishAssetDeletion: (id, token, success, now) =>
            changed(
                "UPDATE site_admin_assets SET state=?,operation_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='deleting' AND operation_token=? RETURNING id",
                [success ? 'deleted' : 'delete_failed', now, id, token],
            ),
        assetStorageMode: async () => {
            const value = (
                await row<{ value: string }>("SELECT value FROM site_admin_meta WHERE key='asset_storage_mode'")
            )?.value
            return value === undefined
                ? undefined
                : value === 'shared'
                  ? { separate: false }
                  : { separate: true, storage: value.replace(/^separate:/u, '') }
        },
        bindAssetStorageMode: async (storage) => {
            await execute([
                {
                    sql: "INSERT INTO site_admin_meta(key,value) VALUES ('asset_storage_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE site_admin_meta.value=excluded.value RETURNING value",
                    params: [`separate:${storage}`],
                    query: true,
                    expectRow: true,
                },
            ])
        },
        hasLegacyAssetOriginals: async () =>
            Boolean(await row("SELECT 1 FROM site_admin_assets WHERE storage<>'draft' AND state<>'deleted' LIMIT 1")),
        assetCopies: async () =>
            (
                await rows<{ key: string; value: string }>(
                    "SELECT key,value FROM site_admin_meta WHERE key LIKE 'asset_copy:%' ORDER BY key",
                )
            ).map(({ key, value }) => ({
                ledger: key.slice('asset_copy:'.length),
                copy: JSON.parse(value) as Awaited<ReturnType<StorageAssets['assetCopies']>>[number]['copy'],
            })),
        claimAssetSync: (lease, now) =>
            changed(
                "INSERT INTO site_admin_meta(key,value) VALUES ('asset_sync_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE site_admin_meta.value<=? RETURNING value",
                [leaseValue(lease), `${now}|~`],
            ),
        releaseAssetSync: async (lease) => {
            await execute([
                {
                    sql: "DELETE FROM site_admin_meta WHERE key='asset_sync_lease' AND value=?",
                    params: [leaseValue(lease)],
                },
            ])
        },
        createAssetCopy: (ledger, copy, guard) => {
            const check = copyGuard(guard)
            return changed(`INSERT INTO site_admin_meta(key,value) SELECT ?,? WHERE ${check.clause} RETURNING key`, [
                `asset_copy:${ledger}`,
                JSON.stringify(copy),
                ...check.params,
            ])
        },
        updateAssetCopy: (ledger, copy, guard) => {
            const check = copyGuard(guard)
            return changed(`UPDATE site_admin_meta SET value=? WHERE key=? AND ${check.clause} RETURNING key`, [
                JSON.stringify(copy),
                `asset_copy:${ledger}`,
                ...check.params,
            ])
        },
        statistics: async () => ({
            entries: await rows(
                `SELECT model,COUNT(*) AS total,SUM(published_revision_id IS NOT NULL) AS published,SUM(current_revision_id<>published_revision_id OR published_revision_id IS NULL) AS drafts,SUM(scheduled_revision_id IS NOT NULL) AS scheduled FROM site_admin_entries GROUP BY model ORDER BY model`,
            ),
            assets: await rows('SELECT state,COUNT(*) AS count FROM site_admin_assets GROUP BY state ORDER BY state'),
            orphanAssets: Number(
                (
                    await row<{ count: number }>(
                        "SELECT COUNT(*) AS count FROM site_admin_assets a WHERE state IN ('ready','delete_failed','upload_failed') AND NOT EXISTS (SELECT 1 FROM site_admin_asset_refs refs WHERE refs.asset_id=a.id)",
                    )
                )?.count ?? 0,
            ),
        }),
    }
}
