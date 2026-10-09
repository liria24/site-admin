import type { DrizzleConnection } from './drizzle'
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
} from '../storage'
import { SiteAdminError } from '../errors'
import { queryRows, runAtomic } from './drizzle-database'
import { revisionSource } from './drizzle-tables'

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(',')
const decodeObject = (value: string): Record<string, unknown> => {
    const result: unknown = JSON.parse(value)
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', 'Stored revision data is not an object.')
    return result as Record<string, unknown>
}
const decodeSlug = (slug: string) => (slug.startsWith('?site-admin-draft:') ? '' : slug)
const encodeSlug = (slug: string, entryId: string) => slug || `?site-admin-draft:${entryId}`
const entryColumns = `e.id, e.model, e.locale, e.translation_group AS translationGroup, e.current_revision_id AS currentRevisionId,
    e.published_revision_id AS publishedRevisionId, e.scheduled_revision_id AS scheduledRevisionId, e.scheduled_at AS scheduledAt,
    e.sort_order AS sortOrder, e.version, e.created_at AS createdAt, e.updated_at AS updatedAt, e.published_at AS publishedAt,
    r.id AS revisionId, r.data, r.slug`
const publishedColumns = `e.id, e.model, e.locale, e.published_at AS publishedAt, e.translation_group AS translationGroup, r.id AS revisionId, r.data, r.slug`
const assetColumns = `id, storage, key, content_type AS contentType, size, checksum, metadata, state,
    operation_token AS operationToken, lease_expires_at AS leaseExpiresAt, created_at AS createdAt, updated_at AS updatedAt`
type StoredEntry = Omit<EntryRecord, 'data'> & { data: string }
type StoredRevision = Omit<RevisionRecord, 'data'> & { data: string }
type StoredPublished = Omit<StoragePublishedEntry, 'data'> & { data: string }
type StoredAsset = Omit<AssetRecord, 'metadata'> & { metadata: string }
const entry = (row: StoredEntry): EntryRecord => ({
    ...row,
    data: decodeObject(row.data),
    slug: decodeSlug(row.slug),
    version: Number(row.version),
})
const revision = (row: StoredRevision): RevisionRecord => ({
    ...row,
    data: decodeObject(row.data),
    slug: decodeSlug(row.slug),
})
const published = (row: StoredPublished): StoragePublishedEntry => ({
    ...row,
    data: decodeObject(row.data),
    slug: decodeSlug(row.slug),
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
        if (filter.locale !== undefined) {
            clauses.push('e.locale=?')
            params.push(filter.locale)
        }
        if (filter.q) {
            clauses.push(
                "(instr(lower(CASE WHEN r.slug LIKE '?site-admin-draft:%' THEN '' ELSE r.slug END),?)>0 OR instr(lower(r.data),?)>0)",
            )
            params.push(filter.q.toLowerCase(), filter.q.toLowerCase())
        }
        return { sql: clauses.join(' AND '), params }
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
            const where = entryFilter(filter)
            return (
                await rows<StoredEntry>(
                    `SELECT ${entryColumns} FROM site_admin_entries e JOIN ${source} r ON r.id=e.current_revision_id WHERE ${where.sql} ORDER BY e.sort_order IS NULL,e.sort_order,e.updated_at DESC,e.id`,
                    where.params,
                )
            ).map(entry)
        },
        pageEntries: async (filter, page) => {
            const where = entryFilter(filter)
            const from = `FROM site_admin_entries e JOIN ${source} r ON r.id=e.current_revision_id WHERE ${where.sql}`
            const results = await execute([
                { sql: `SELECT COUNT(*) AS total ${from}`, params: where.params, query: true },
                {
                    sql: `SELECT ${entryColumns} ${from} ORDER BY e.sort_order IS NULL,e.sort_order,e.updated_at DESC,e.id LIMIT ? OFFSET ?`,
                    params: [...where.params, page.limit, page.offset],
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
                `SELECT id,entry_id AS entryId,actor_id AS actorId,created_at AS createdAt,data,slug FROM ${source} WHERE id=?${entryId === undefined ? '' : ' AND entry_id=?'}`,
                entryId === undefined ? [id] : [id, entryId],
            )
            return value && revision(value)
        },
        revisions: async (entryId) =>
            (
                await rows<StoredRevision>(
                    `SELECT id,entry_id AS entryId,actor_id AS actorId,created_at AS createdAt,data,slug FROM ${source} WHERE entry_id=? ORDER BY created_at DESC`,
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
            if (filter.locale !== undefined) {
                clauses.push('e.locale=?')
                params.push(filter.locale)
            }
            if (filter.key !== undefined) {
                clauses.push('(r.slug=? OR e.id=?)')
                params.push(filter.key, filter.key)
            }
            for (const [column, values] of [
                ['e.id', filter.ids],
                ['e.translation_group', filter.translationGroups],
            ] as const) {
                if (values === undefined) continue
                if (!values.length) return []
                clauses.push(`${column} IN (SELECT value FROM json_each(?))`)
                params.push(JSON.stringify(values))
            }
            return (
                await rows<StoredPublished>(
                    `SELECT ${publishedColumns} FROM site_admin_entries e JOIN ${source} r ON r.id=e.published_revision_id WHERE ${clauses.join(' AND ')} ORDER BY e.sort_order IS NULL,e.sort_order,e.published_at DESC,e.id`,
                    params,
                )
            ).map(published)
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
            const guard = conditions(input.conditions),
                statements: AtomicStatement[] = []
            const targetIds = [...(input.updates ?? []).map(({ id }) => id), ...(input.delete ? [input.delete] : [])]
            if (targetIds.length) {
                guard.clause +=
                    ' AND NOT EXISTS (SELECT 1 FROM json_each(?) candidate LEFT JOIN site_admin_entries e ON e.id=candidate.value WHERE e.id IS NULL)'
                guard.params.push(JSON.stringify(targetIds))
            }
            const gated = (sql: string, params: DatabaseValue[], returning = false): AtomicStatement => ({
                sql: `${sql} WHERE ${guard.clause}${returning ? ' RETURNING id' : ''}`,
                params: [...params, ...guard.params],
                ...(returning ? { query: true, expectRow: true } : {}),
            })
            // D1 batches cannot throw on an empty RETURNING result before commit. Gate every dependent write.
            statements.push({
                sql: `SELECT 1 WHERE ${guard.clause}`,
                params: guard.params,
                query: true,
                expectRow: true,
            })
            if (input.create) {
                const value = input.create
                statements.push(
                    gated(
                        'INSERT INTO site_admin_entries(id,model,locale,translation_group,current_revision_id,published_revision_id,scheduled_revision_id,scheduled_at,sort_order,version,created_at,updated_at,published_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?',
                        [
                            value.id,
                            value.model,
                            value.locale,
                            value.translationGroup,
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
                    gated('INSERT INTO site_admin_revisions(id,entry_id,slug,actor_id,created_at) SELECT ?,?,?,?,?', [
                        value.id,
                        value.entryId,
                        encodeSlug(value.slug, value.entryId),
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
                for (const ref of value.relations)
                    statements.push(
                        gated(
                            'INSERT INTO site_admin_relations(revision_id,field_path,target_entry_id,position,required) SELECT ?,?,?,?,?',
                            [value.id, ref.path, ref.id, ref.position, Number(ref.required)],
                        ),
                    )
                for (const ref of value.assets)
                    statements.push(
                        gated(
                            'INSERT INTO site_admin_asset_refs(revision_id,field_path,asset_id,position) SELECT ?,?,?,?',
                            [value.id, ref.path, ref.id, ref.position],
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
                        sql: `UPDATE site_admin_routes SET target_path=?,status=? WHERE entry_id=? AND kind='historical' AND ${guard.clause}`,
                        params: [change.path, change.status, change.entryId, ...guard.params],
                    })
                else {
                    const clauses = ['entry_id=?'],
                        params: DatabaseValue[] = [change.entryId]
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
