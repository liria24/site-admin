import type { SiteAdminDatabase, DatabaseValue, AtomicStatement } from '../adapter'
export type { AtomicStatement } from '../adapter'

export const runAtomic = (database: SiteAdminDatabase, statements: AtomicStatement[]) => database.atomic(statements)

export const queryRows = async <Row extends object>(
    database: SiteAdminDatabase,
    sql: string,
    params: DatabaseValue[] = [],
): Promise<Row[]> => (await database.query(sql, params)) as Row[]

export const queryRow = async <Row extends object>(
    database: SiteAdminDatabase,
    sql: string,
    params: DatabaseValue[] = [],
): Promise<Row | undefined> => (await queryRows<Row>(database, sql, params))[0]
