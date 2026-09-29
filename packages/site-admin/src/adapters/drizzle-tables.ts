import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { SiteAdminConfig } from '../config'
import type { AnyField } from '../fields'

export const entries = sqliteTable(
    'site_admin_entries',
    {
        id: text().primaryKey(),
        model: text().notNull(),
        locale: text().notNull().default(''),
        translation_group: text().notNull(),
        current_revision_id: text(),
        published_revision_id: text(),
        scheduled_revision_id: text(),
        scheduled_at: text(),
        sort_order: real(),
        version: integer().notNull().default(0),
        created_at: text().notNull(),
        updated_at: text().notNull(),
        published_at: text(),
    },
    (table) => [
        uniqueIndex('site_admin_entries_translation').on(table.model, table.translation_group, table.locale),
        index('site_admin_entries_model').on(table.model),
        index('site_admin_entries_schedule')
            .on(table.scheduled_at)
            .where(sql`${table.scheduled_revision_id} IS NOT NULL`),
    ],
)

export const revisions = sqliteTable(
    'site_admin_revisions',
    {
        id: text().primaryKey(),
        entry_id: text()
            .notNull()
            .references(() => entries.id, { onDelete: 'cascade' }),
        slug: text().notNull(),
        actor_id: text(),
        created_at: text().notNull(),
    },
    (table) => [index('site_admin_revisions_entry').on(table.entry_id, table.created_at)],
)

export const assets = sqliteTable(
    'site_admin_assets',
    {
        id: text().primaryKey(),
        storage: text().notNull(),
        key: text().notNull(),
        content_type: text().notNull(),
        size: integer().notNull(),
        checksum: text(),
        metadata: text().notNull().default('{}'),
        state: text().notNull(),
        operation_token: text(),
        lease_expires_at: text(),
        created_at: text().notNull(),
        updated_at: text().notNull(),
    },
    (table) => [
        uniqueIndex('site_admin_assets_key').on(table.storage, table.key),
        index('site_admin_assets_gc').on(table.state, table.created_at),
    ],
)

export const relations = sqliteTable(
    'site_admin_relations',
    {
        revision_id: text()
            .notNull()
            .references(() => revisions.id, { onDelete: 'cascade' }),
        field_path: text().notNull(),
        target_entry_id: text()
            .notNull()
            .references(() => entries.id, { onDelete: 'restrict' }),
        position: integer().notNull(),
        required: integer().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.revision_id, table.field_path, table.position] }),
        index('site_admin_relations_target').on(table.target_entry_id),
    ],
)

export const assetRefs = sqliteTable(
    'site_admin_asset_refs',
    {
        revision_id: text()
            .notNull()
            .references(() => revisions.id, { onDelete: 'cascade' }),
        field_path: text().notNull(),
        asset_id: text()
            .notNull()
            .references(() => assets.id, { onDelete: 'restrict' }),
        position: integer().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.revision_id, table.field_path, table.position] }),
        index('site_admin_asset_refs_asset').on(table.asset_id),
    ],
)

export const routes = sqliteTable(
    'site_admin_routes',
    {
        path: text().notNull(),
        locale: text().notNull().default(''),
        entry_id: text()
            .notNull()
            .references(() => entries.id, { onDelete: 'cascade' }),
        revision_id: text().references(() => revisions.id, { onDelete: 'cascade' }),
        kind: text().notNull(),
        target_path: text(),
        status: integer(),
        created_at: text().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.locale, table.path] }),
        index('site_admin_routes_entry').on(table.entry_id),
    ],
)

export const meta = sqliteTable('site_admin_meta', { key: text().primaryKey(), value: text().notNull() })

export const fieldStorage = (field: AnyField): 'text' | 'integer' | 'real' | 'boolean' | 'json' => {
    if (field.kind === 'number') return field.integer ? 'integer' : 'real'
    if (field.kind === 'boolean') return 'boolean'
    if (['object', 'array', 'image', 'images', 'file'].includes(field.kind)) return 'json'
    return 'text'
}

export const contentTableName = (name: string): string => `site_admin_content_${name}`
export const validateContentNames = (config: SiteAdminConfig): void => {
    const models = new Set<string>()
    for (const [name, model] of Object.entries(config.models)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name) || models.has(name.toLowerCase()))
            throw new Error(`Invalid or duplicate Model name: ${name}`)
        models.add(name.toLowerCase())
        const fields = new Set<string>()
        for (const key of Object.keys(model.fields)) {
            if (!/^[A-Za-z0-9_-]{1,128}$/u.test(key) || key === 'revisionId' || fields.has(key.toLowerCase()))
                throw new Error(`Invalid or reserved field: ${name}.${key}`)
            fields.add(key.toLowerCase())
        }
    }
}
/** SQL-only projection; content is stored in typed columns, never a second JSON document. */
export const revisionSource = (config: SiteAdminConfig): string => {
    const branches = Object.entries(config.models).map(([name, model]) => {
        const pairs = Object.entries(model.fields).map(([key, field]) => {
            const column = `d.${JSON.stringify(`field_${key}`)}`,
                storage = fieldStorage(field)
            const value =
                storage === 'json'
                    ? column
                    : storage === 'boolean'
                      ? `CASE WHEN ${column}=1 THEN 'true' ELSE 'false' END`
                      : `json_quote(${column})`
            return `('${key.replaceAll("'", "''")}', CASE WHEN ${column} IS NULL THEN NULL ELSE ${value} END)`
        })
        const data = pairs.length
            ? `(SELECT json_group_object(column1,json(column2)) FROM (VALUES ${pairs.join(',')}) WHERE column2 IS NOT NULL)`
            : "'{}'"
        return `WHEN '${name.replaceAll("'", "''")}' THEN (SELECT ${data} FROM ${JSON.stringify(contentTableName(name))} d WHERE d.revision_id=r.id)`
    })
    // VALUES and CASE avoid compound-SELECT limits and keep reads independent of entry count.
    // ponytail: SQL size grows with Model/field count; split by Model if the platform SQL-size ceiling is reached.
    return branches.length
        ? `(SELECT r.*, CASE e.model ${branches.join(' ')} END AS data FROM site_admin_revisions r JOIN site_admin_entries e ON e.id=r.entry_id WHERE e.model IN (${Object.keys(
              config.models,
          )
              .map((name) => `'${name.replaceAll("'", "''")}'`)
              .join(',')}))`
        : "(SELECT r.*, '{}' AS data FROM site_admin_revisions r WHERE 0)"
}
