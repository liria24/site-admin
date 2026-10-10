import type { DrizzleSiteAdminDatabase } from '../packages/site-admin/src/adapters/drizzle'
import type { DatabaseValue, AtomicStatement } from '../packages/site-admin/src/adapters/sqlite-statements'

/** Adapter-specific inspection for tests; Core never receives SQL. */
export const runAtomic = (database: DrizzleSiteAdminDatabase, statements: AtomicStatement[]) =>
    database.atomic(statements)
export const queryRows = async <Row extends object>(
    database: DrizzleSiteAdminDatabase,
    sql: string,
    params: DatabaseValue[] = [],
): Promise<Row[]> => (await database.query(sql, params)) as Row[]
export const queryRow = async <Row extends object>(
    database: DrizzleSiteAdminDatabase,
    sql: string,
    params: DatabaseValue[] = [],
): Promise<Row | undefined> => (await queryRows<Row>(database, sql, params))[0]
