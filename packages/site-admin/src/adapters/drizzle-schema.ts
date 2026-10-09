import type { DrizzleConnection as Database } from './drizzle'
import { getTableColumns } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import type { SiteAdminConfig } from '../config'
import { SiteAdminError } from '../errors'
import { queryRows } from './drizzle-database'
import {
    assets,
    assetRefs,
    contentTableName,
    fieldStorage,
    validateContentNames,
    entries,
    meta,
    relations,
    revisions,
    routes,
} from './drizzle-tables'

const nullDefault = (value: string | null): boolean =>
    value === null || value.replace(/[\s()]/gu, '').toLowerCase() === 'null'

type NativeSchemaRow =
    | {
          kind: 'column'
          tableName: string
          name: string
          type: string
          notnull: number
          pk: number
          dflt_value: string | null
          indexName: null
      }
    | {
          kind: 'index'
          tableName: string
          name: string | null
          type: null
          notnull: null
          pk: null
          dflt_value: null
          indexName: string
      }

export function contentTables(database: Database, config: SiteAdminConfig) {
    validateContentNames(config)
    return Object.fromEntries(
        Object.entries(config.models).map(([name, model]) => {
            const table = database.tables.get(contentTableName(name))
            if (!table)
                throw new SiteAdminError(
                    'SITE_ADMIN_SCHEMA_INCOMPATIBLE',
                    `Missing generated table for Model "${name}".`,
                )
            const columns = getTableColumns(table)
            if (columns.revisionId?.name !== 'revision_id' || !columns.revisionId.primary)
                throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', `Regenerate the schema for Model "${name}".`)
            for (const [key, field] of Object.entries(model.fields)) {
                const column = columns[key],
                    storage = fieldStorage(field)
                const type = storage === 'json' ? 'text' : storage === 'boolean' ? 'integer' : storage
                const dataType =
                    storage === 'json'
                        ? 'object json'
                        : storage === 'boolean'
                          ? 'boolean'
                          : storage === 'text'
                            ? 'string'
                            : storage === 'integer'
                              ? 'number int53'
                              : 'number double'
                if (
                    !column ||
                    column.name !== `field_${key}` ||
                    column.getSQLType() !== type ||
                    column.dataType !== dataType ||
                    column.notNull !== Boolean(field.required)
                )
                    throw new SiteAdminError(
                        'SITE_ADMIN_SCHEMA_INCOMPATIBLE',
                        `Regenerate the schema for "${name}.${key}".`,
                    )
            }
            return [name, table]
        }),
    )
}

/** Read-only check: migrations are generated and applied outside the runtime. */
export const assertSiteAdminSchema = async (database: Database, config: SiteAdminConfig): Promise<void> => {
    if (database.dialect !== 'sqlite')
        throw new SiteAdminError('SITE_ADMIN_DATABASE_UNSUPPORTED', 'Site Admin currently supports SQLite and D1.')
    const tables = [
        entries,
        revisions,
        assets,
        relations,
        assetRefs,
        routes,
        meta,
        ...Object.values(contentTables(database, config)),
    ]
    // Table-valued PRAGMAs keep all read-only compatibility checks in one native snapshot/call.
    const nativeRows = await queryRows<NativeSchemaRow>(
        database,
        `WITH names AS (SELECT value FROM json_each(?))
        SELECT 'column' AS kind,t.value AS tableName,p.name,p.type,p."notnull" AS "notnull",p.pk,p.dflt_value,NULL AS indexName FROM names t JOIN pragma_table_info(t.value) p
        UNION ALL SELECT 'index',t.value,p.name,NULL,NULL,NULL,NULL,i.name FROM names t JOIN pragma_index_list(t.value) i JOIN pragma_index_info(i.name) p WHERE i."unique"=1`,
        [JSON.stringify(tables.map((table) => getTableConfig(table).name))],
    )
    for (const table of tables) {
        const expected = getTableConfig(table)
        const model = Object.entries(config.models).find(([name]) => contentTableName(name) === expected.name)?.[1]
        // Removed fields may stay in the application schema and physical history table.
        // Reads and inserts use only these active columns; retained columns are checked for write compatibility below.
        const required = model
            ? expected.columns.filter(
                  (column) =>
                      column.name === 'revision_id' ||
                      Object.keys(model.fields).some((key) => column.name === `field_${key}`),
              )
            : expected.columns
        const supplied = database.tables.get(expected.name)
        if (
            !supplied ||
            required.some((column) => {
                const actual = getTableConfig(supplied).columns.find((item) => item.name === column.name)
                return (
                    !actual ||
                    actual.getSQLType() !== column.getSQLType() ||
                    actual.notNull !== column.notNull ||
                    actual.primary !== column.primary
                )
            })
        )
            throw new SiteAdminError(
                'SITE_ADMIN_SCHEMA_INCOMPATIBLE',
                `Missing or incompatible generated schema table "${expected.name}".`,
            )
        const columns = nativeRows
            .filter((row) => row.kind === 'column')
            .filter((row) => row.tableName === expected.name)
        if (
            required.some((column) => {
                const actual = columns.find((item) => item.name === column.name)
                return (
                    !actual ||
                    actual.type.toLowerCase() !== column.getSQLType().toLowerCase() ||
                    (column.notNull && !actual.notnull && !actual.pk) ||
                    (!column.notNull && !column.primary && Boolean(actual.notnull)) ||
                    (column.primary && !actual.pk)
                )
            }) ||
            columns.some(
                (column) =>
                    !required.some((item) => item.name === column.name) &&
                    (column.pk || (column.notnull && nullDefault(column.dflt_value))),
            )
        )
            throw new SiteAdminError(
                'SITE_ADMIN_MIGRATION_REQUIRED',
                `Database table "${expected.name}" does not match the generated schema. Generate and apply its Drizzle migrations explicitly.`,
            )
        // A retained UNIQUE key must be safe for every active-column insert.
        // Do not infer safety from partial predicates or nonconstant default expressions.
        const indexes = nativeRows
            .filter((row) => row.kind === 'index')
            .filter((row) => row.tableName === expected.name)
        for (const indexName of new Set(indexes.map((row) => row.indexName))) {
            const indexed = indexes.filter((row) => row.indexName === indexName)
            const retained = indexed.flatMap(({ name }) => {
                const column = columns.find((item) => item.name === name)
                return column && !required.some((item) => item.name === name) ? [column] : []
            })
            const uniqueRevision = indexed.some(({ name }) =>
                required.some((column) => column.name === name && column.primary),
            )
            const omittedNull = retained.some((column) => !column.notnull && nullDefault(column.dflt_value))
            if (retained.length && !uniqueRevision && !omittedNull)
                throw new SiteAdminError(
                    'SITE_ADMIN_MIGRATION_REQUIRED',
                    `Retained UNIQUE columns in "${expected.name}" prevent active-column inserts. Generate and apply its Drizzle migrations explicitly.`,
                )
        }
    }
}
