import { is, getTableName, getTableColumns, entityKind } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { SiteAdminError } from '../errors'
import type { SiteAdminDatabase } from '../adapter'
import type { AtomicStatement, AtomicResult, DatabaseValue as Primitive } from './sqlite-statements'
import { queryRows, runAtomic } from './drizzle-database'
import { assertSiteAdminSchema, contentTables } from './drizzle-schema'
import { sqliteStorage } from './sqlite-storage'

// Structural input also accepts a consumer's separately installed copy of Drizzle.
type DrizzleDatabase = { $client: unknown; insert: (...args: never[]) => unknown }
interface Statement {
    all(...params: Primitive[]): unknown
    run(...params: Primitive[]): unknown
    bind?(...params: Primitive[]): Statement
}
interface Client {
    prepare(sql: string): Statement
    exec?(sql: string): unknown
    batch?: (statements: Statement[]) => Promise<unknown[]>
}

/** Uses the application's Drizzle instance and its native SQLite/D1 transaction boundary. */
export interface DrizzleSiteAdminDatabase extends SiteAdminDatabase {
    query(sql: string, params?: Primitive[]): Promise<unknown[]>
    atomic(statements: AtomicStatement[]): Promise<AtomicResult[]>
}

export function drizzleAdapter(
    db: DrizzleDatabase,
    options: { schema: Record<string, unknown> },
): DrizzleSiteAdminDatabase {
    const client = db?.$client as Client | undefined
    if (
        !client ||
        typeof db.insert !== 'function' ||
        typeof client.prepare !== 'function' ||
        (typeof client.batch !== 'function' && typeof client.exec !== 'function')
    )
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            'Provide a Drizzle SQLite/D1 instance with a native transactional client.',
        )
    const native = client
    const driver = (db.constructor as unknown as Record<symbol, string>)[entityKind]
    if (
        native.batch
            ? driver !== 'D1Database'
            : !['NodeSQLiteDatabase', 'BetterSQLite3Database', 'SQLiteBunDatabase'].includes(driver ?? '')
    )
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            'Supported Drizzle drivers are D1 and synchronous SQLite (node-sqlite, better-sqlite3, bun-sqlite).',
        )
    const tables = new Map<string, SQLiteTable>()
    for (const value of Object.values(options.schema)) {
        if (!is(value, SQLiteTable)) continue
        const name = getTableName(value)
        if (tables.has(name) && tables.get(name) !== value) throw new Error(`Duplicate schema table: ${name}`)
        tables.set(name, value)
    }
    const connection: DrizzleConnection = {
        tables,
        lockKey: native,
        dialect: 'sqlite',
        getInstance: async () => native,
        prepare: (sql: string) => ({
            all: async (...params: Primitive[]): Promise<unknown[]> => {
                const statement = native.prepare(sql)
                if (native.batch) {
                    const result = (await statement.bind!(...params).all()) as { results: unknown[] }
                    return result.results
                }
                return (await statement.all(...params)) as unknown[]
            },
        }),
    }
    return {
        query: (sql, params) => queryRows(connection, sql, params),
        atomic: async (statements) => {
            try {
                return await runAtomic(connection, statements)
            } catch (error) {
                if (
                    !(error instanceof SiteAdminError) &&
                    error instanceof Error &&
                    /site_admin_routes(?:\.path)?/iu.test(error.message)
                )
                    throw new SiteAdminError(
                        'SITE_ADMIN_ROUTE_CONFLICT',
                        'Another public route already owns this path.',
                    )
                throw error
            }
        },
        bind(config) {
            const mapped = contentTables(connection, config)
            const insertRevisionData = (
                model: string,
                revisionId: string,
                data: Record<string, unknown>,
            ): AtomicStatement => {
                const table = mapped[model]
                if (!table) throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', `Unknown Model "${model}".`)
                const columns = getTableColumns(table)
                const keys = ['revisionId', ...Object.keys(config.models[model]!.fields)]
                const values: Record<string, unknown> = { ...data, revisionId }
                const params = keys.map((key) => {
                    const value = values[key]
                    return value === undefined || value === null ? null : columns[key]!.mapToDriverValue(value)
                }) as Primitive[]
                return {
                    sql: `INSERT INTO ${JSON.stringify(getTableName(table))}(${keys.map((key) => JSON.stringify(columns[key]!.name)).join(',')}) SELECT ${keys.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM site_admin_revisions WHERE id = ?)`,
                    params: [...params, revisionId],
                }
            }
            return {
                assertSchema: () => assertSiteAdminSchema(connection, config),
                ...sqliteStorage(connection, config, insertRevisionData),
            }
        },
    }
}

/** Adapter-private native connection. Not part of the Core storage contract. */
export interface DrizzleConnection {
    tables: Map<string, SQLiteTable>
    lockKey: object
    dialect: string
    getInstance(): Promise<Client>
    prepare(sql: string): {
        all(...params: Primitive[]): Promise<unknown[]>
    }
}
