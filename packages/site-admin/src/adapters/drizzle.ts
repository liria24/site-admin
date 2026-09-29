import type { EmptyRelations } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { is, getTableName, entityKind } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { SiteAdminError } from '../errors'
import type { SiteAdminDatabase, DatabaseValue as Primitive } from '../adapter'
import { queryRows, runAtomic } from './drizzle-database'
import { assertSiteAdminSchema, contentTables } from './drizzle-schema'
import { revisionSource } from './drizzle-tables'

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
export function drizzleAdapter(db: DrizzleDatabase, options: { schema: Record<string, unknown> }): SiteAdminDatabase {
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
        orm: db as unknown as Pick<SQLiteAsyncDatabase<'sync' | 'async', unknown, EmptyRelations>, 'insert'>,
        tables,
        lockKey: native,
        dialect: 'sqlite',
        connector: native.batch ? 'd1' : 'sqlite',
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
        dialect: 'sqlite',
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
            return {
                assertSchema: () => assertSiteAdminSchema(connection, config),
                revisionSource: revisionSource(config),
                insertRevisionData(model, revisionId, data) {
                    const table = mapped[model]
                    if (!table) throw new SiteAdminError('SITE_ADMIN_SCHEMA_INCOMPATIBLE', `Unknown Model "${model}".`)
                    const content = connection.orm
                        .insert(table)
                        .values({ ...data, revisionId })
                        .toSQL()
                    const guarded = content.sql.replace(/ values \((.*)\)$/u, ' select $1')
                    if (guarded === content.sql) throw new Error('Unexpected Drizzle insert SQL shape.')
                    return {
                        sql: guarded + ' WHERE EXISTS (SELECT 1 FROM site_admin_revisions WHERE id = ?)',
                        params: [...(content.params as Primitive[]), revisionId],
                    }
                },
            }
        },
    }
}

/** Adapter-private native connection. Not part of the Core storage contract. */
export interface DrizzleConnection {
    orm: Pick<SQLiteAsyncDatabase<'sync' | 'async', unknown, EmptyRelations>, 'insert'>
    tables: Map<string, SQLiteTable>
    lockKey: object
    dialect: string
    connector: string
    getInstance(): Promise<Client>
    prepare(sql: string): {
        all(...params: Primitive[]): Promise<unknown[]>
    }
}
