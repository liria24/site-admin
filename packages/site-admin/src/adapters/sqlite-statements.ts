import { SiteAdminError } from '../errors'

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
