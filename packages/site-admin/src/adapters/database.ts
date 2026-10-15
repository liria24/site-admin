import { is, getTableName, getTableColumns } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { SiteAdminError } from '../errors'
import type { SiteAdminDatabase } from '../adapter'
import type { AtomicStatement, AtomicResult, DatabaseValue as Primitive } from './sqlite-statements'
import { queryRows, runAtomic } from './drizzle-database'
import { assertSiteAdminSchema, contentTables } from './drizzle-schema'
import { sqliteStorage } from './sqlite-storage'

interface Statement {
    all(...params: Primitive[]): unknown
    run(...params: Primitive[]): unknown
    bind(...params: Primitive[]): Statement
}
interface Client {
    prepare(sql: string): Statement
    batch: (
        statements: Statement[],
    ) => Promise<Array<{ results?: unknown[]; success?: boolean; error?: string; meta?: { changes?: number } }>>
}

const adapters = new WeakMap<object, WeakMap<object, DrizzleSiteAdminDatabase>>()

/** Internal storage operations backed by the Void D1 binding. */
export interface DrizzleSiteAdminDatabase extends SiteAdminDatabase {
    query(sql: string, params?: Primitive[]): Promise<unknown[]>
    atomic(statements: AtomicStatement[]): Promise<AtomicResult[]>
}

export function createD1Database(client: Client, schema: Record<string, unknown>): DrizzleSiteAdminDatabase {
    if (!client || typeof client.prepare !== 'function' || typeof client.batch !== 'function')
        throw new SiteAdminError('SITE_ADMIN_DATABASE_UNSUPPORTED', 'Site Admin requires the Void D1 database binding.')
    const cached = adapters.get(client)?.get(schema)
    if (cached) return cached
    const native = client
    const tables = new Map<string, SQLiteTable>()
    for (const value of Object.values(schema)) {
        if (!is(value, SQLiteTable)) continue
        const name = getTableName(value)
        if (tables.has(name) && tables.get(name) !== value) throw new Error(`Duplicate schema table: ${name}`)
        tables.set(name, value)
    }
    const connection: DrizzleConnection = {
        tables,
        lockKey: native,
        getInstance: async () => native,
        prepare: (sql: string) => ({
            all: async (...params: Primitive[]): Promise<unknown[]> => {
                const statement = native.prepare(sql)
                const result = (await statement.bind(...params).all()) as { results: unknown[] }
                return result.results
            },
        }),
    }
    const adapter: DrizzleSiteAdminDatabase = {
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
    let schemas = adapters.get(native)
    if (!schemas) adapters.set(native, (schemas = new WeakMap()))
    schemas.set(schema, adapter)
    return adapter
}

/** Adapter-private native connection. Not part of the Core storage contract. */
export interface DrizzleConnection {
    tables: Map<string, SQLiteTable>
    lockKey: object
    getInstance(): Promise<Client>
    prepare(sql: string): {
        all(...params: Primitive[]): Promise<unknown[]>
    }
}
