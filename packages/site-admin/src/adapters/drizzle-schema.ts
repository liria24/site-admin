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
            if (
                Object.keys(columns).length !== Object.keys(model.fields).length + 1 ||
                columns.revisionId?.name !== 'revision_id' ||
                !columns.revisionId.primary
            )
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
    for (const table of tables) {
        const expected = getTableConfig(table)
        const supplied = database.tables.get(expected.name)
        if (
            !supplied ||
            JSON.stringify(getTableConfig(supplied).columns.map((c) => [c.name, c.getSQLType(), c.notNull])) !==
                JSON.stringify(expected.columns.map((c) => [c.name, c.getSQLType(), c.notNull]))
        )
            throw new SiteAdminError(
                'SITE_ADMIN_SCHEMA_INCOMPATIBLE',
                `Missing or incompatible generated schema table "${expected.name}".`,
            )
        const columns = await queryRows<{ name: string; type: string; notnull: number; pk: number }>(
            database,
            `PRAGMA table_info(${JSON.stringify(expected.name)})`,
        )
        if (
            columns.length !== expected.columns.length ||
            expected.columns.some((column) => {
                const actual = columns.find((item) => item.name === column.name)
                return (
                    !actual ||
                    actual.type.toLowerCase() !== column.getSQLType().toLowerCase() ||
                    (column.notNull && !actual.notnull && !actual.pk)
                )
            })
        )
            throw new SiteAdminError(
                'SITE_ADMIN_MIGRATION_REQUIRED',
                `Database table "${expected.name}" does not match the generated schema. Generate and apply its Drizzle migrations explicitly.`,
            )
    }
}
