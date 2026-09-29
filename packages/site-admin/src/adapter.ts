import type { SiteAdminConfig } from './config'
import { SiteAdminError } from './errors'

export type DatabaseValue = string | number | bigint | boolean | null | Uint8Array

export interface AtomicStatement {
    expectRow?: boolean
    params?: DatabaseValue[]
    query?: boolean
    sql: string
}

export interface AtomicResult {
    changes?: number
    rows: unknown[]
}

/** Call inside an interactive transaction, before commit. Native batches must guard every dependent write. */
export function assertAtomicResults(statements: AtomicStatement[], results: AtomicResult[]): void {
    if (statements.length !== results.length) throw new Error('Incomplete atomic statement results.')
    for (const [index, statement] of statements.entries()) {
        if (statement.expectRow && results[index]!.rows.length === 0)
            throw new SiteAdminError('SITE_ADMIN_CONFLICT', 'The entry changed before this mutation committed.')
    }
}

/** Configuration-bound storage mapping; never expose ORM tables or clients to Core. */
export interface SiteAdminStorage {
    assertSchema(): Promise<void>
    readonly revisionSource: string
    insertRevisionData(model: string, revisionId: string, data: Record<string, unknown>): AtomicStatement
}

/**
 * SQLite storage protocol, independent of ORM and connection APIs.
 * Values are bound separately; adapters normalize driver results and errors.
 * atomic must preserve statement order and all-or-nothing writes, including optimistic guards.
 * Reads and writes sharing a connection must use the same serialization boundary.
 * bind validates the supplied application schema; assertSchema checks the physical DB without DDL.
 * The application owns connection lifecycle and migrations.
 */
export interface SiteAdminDatabase {
    readonly dialect: 'sqlite'
    query(sql: string, params?: DatabaseValue[]): Promise<unknown[]>
    atomic(statements: AtomicStatement[]): Promise<AtomicResult[]>
    bind(config: SiteAdminConfig): SiteAdminStorage
}
