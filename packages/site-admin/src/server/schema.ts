import type { Database } from 'db0'

import { SiteAdminError } from '../errors'
import { queryRow, runAtomic } from './database'

export const SITE_ADMIN_SCHEMA_VERSION = 1

const ddl = [
    `CREATE TABLE IF NOT EXISTS site_admin_entries (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        locale TEXT NOT NULL DEFAULT '',
        translation_group TEXT NOT NULL,
        current_revision_id TEXT,
        published_revision_id TEXT,
        scheduled_revision_id TEXT,
        scheduled_at TEXT,
        sort_order REAL,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS site_admin_entries_translation
        ON site_admin_entries(model, translation_group, locale)`,
    `CREATE INDEX IF NOT EXISTS site_admin_entries_model ON site_admin_entries(model)`,
    `CREATE INDEX IF NOT EXISTS site_admin_entries_schedule
        ON site_admin_entries(scheduled_at) WHERE scheduled_revision_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS site_admin_revisions (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES site_admin_entries(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        slug TEXT NOT NULL,
        actor_id TEXT,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS site_admin_revisions_entry ON site_admin_revisions(entry_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS site_admin_assets (
        id TEXT PRIMARY KEY,
        storage TEXT NOT NULL,
        key TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        checksum TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(storage, key)
    )`,
    `CREATE INDEX IF NOT EXISTS site_admin_assets_gc ON site_admin_assets(state, created_at)`,
    `CREATE TABLE IF NOT EXISTS site_admin_relations (
        revision_id TEXT NOT NULL REFERENCES site_admin_revisions(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        target_entry_id TEXT NOT NULL REFERENCES site_admin_entries(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        required INTEGER NOT NULL,
        PRIMARY KEY(revision_id, field_path, position)
    )`,
    `CREATE INDEX IF NOT EXISTS site_admin_relations_target ON site_admin_relations(target_entry_id)`,
    `CREATE TABLE IF NOT EXISTS site_admin_asset_refs (
        revision_id TEXT NOT NULL REFERENCES site_admin_revisions(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES site_admin_assets(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        PRIMARY KEY(revision_id, field_path, position)
    )`,
    `CREATE INDEX IF NOT EXISTS site_admin_asset_refs_asset ON site_admin_asset_refs(asset_id)`,
    `CREATE TABLE IF NOT EXISTS site_admin_routes (
        path TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES site_admin_entries(id) ON DELETE CASCADE,
        revision_id TEXT REFERENCES site_admin_revisions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        target_path TEXT,
        status INTEGER,
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS site_admin_routes_entry ON site_admin_routes(entry_id)`,
    `CREATE TABLE IF NOT EXISTS site_admin_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
]

interface MetaRow {
    value: string
}

export const migrateSiteAdmin = async (database: Database): Promise<void> => {
    await runAtomic(database, [
        ...ddl.map((sql) => ({ sql })),
        {
            sql: 'INSERT OR IGNORE INTO site_admin_meta(key, value) VALUES (?, ?)',
            params: ['schema_version', String(SITE_ADMIN_SCHEMA_VERSION)],
        },
        {
            sql: "INSERT OR IGNORE INTO site_admin_meta(key, value) VALUES ('public_generation', '0')",
        },
    ])
    await assertSiteAdminSchema(database)
}

export const assertSiteAdminSchema = async (database: Database): Promise<void> => {
    let row: MetaRow | undefined
    try {
        row = await queryRow<MetaRow>(
            database,
            "SELECT value FROM site_admin_meta WHERE key = 'schema_version'",
        )
    } catch {
        throw new SiteAdminError(
            'SITE_ADMIN_MIGRATION_REQUIRED',
            'Site Admin database schema is missing. Run migrateSiteAdmin() as a deployment operation.',
        )
    }
    if (!row) {
        throw new SiteAdminError(
            'SITE_ADMIN_MIGRATION_REQUIRED',
            'Site Admin database schema is missing. Run migrateSiteAdmin() as a deployment operation.',
        )
    }
    if (Number(row.value) !== SITE_ADMIN_SCHEMA_VERSION) {
        throw new SiteAdminError(
            'SITE_ADMIN_SCHEMA_INCOMPATIBLE',
            `Database schema ${row.value} is incompatible with runtime schema ${SITE_ADMIN_SCHEMA_VERSION}.`,
        )
    }
}

export const initializeSiteAdminDatabase = async (database: Database): Promise<void> => {
    if (database.connector === 'node-sqlite') await migrateSiteAdmin(database)
    else await assertSiteAdminSchema(database)
}
