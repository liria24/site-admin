import type { DrizzleConnection as Database } from './drizzle'
import type { AtomicStatement, AtomicResult, DatabaseValue as Primitive } from '../adapter'
import { assertAtomicResults } from '../adapter'

import { SiteAdminError } from '../errors'

interface D1Result {
    error?: string
    meta?: { changes?: number }
    results?: unknown[]
    success?: boolean
}

interface D1Statement {
    bind(...params: Primitive[]): D1Statement
}

interface D1Database {
    batch(statements: D1Statement[]): Promise<D1Result[]>
    prepare(sql: string): D1Statement
}

const isD1Database = (value: unknown): value is D1Database =>
    typeof value === 'object' &&
    value !== null &&
    'batch' in value &&
    typeof value.batch === 'function' &&
    'prepare' in value &&
    typeof value.prepare === 'function'

const locks = new WeakMap<object, Promise<void>>()
const noop = (): void => undefined

const withLock = async <Value>(key: object, task: () => Promise<Value>): Promise<Value> => {
    const previous = locks.get(key) ?? Promise.resolve()
    let release = noop
    const current = new Promise<void>((resolve) => (release = resolve))
    const queued = previous.then(() => current)
    locks.set(key, queued)
    await previous
    try {
        return await task()
    } finally {
        release()
        if (locks.get(key) === queued) locks.delete(key)
    }
}

const runD1Batch = async (instance: D1Database, statements: AtomicStatement[]): Promise<AtomicResult[]> => {
    const prepared = statements.map((statement) => instance.prepare(statement.sql).bind(...(statement.params ?? [])))
    const raw = await instance.batch(prepared)
    const results = raw.map((result) => {
        if (result.success === false || result.error) throw new Error(result.error ?? 'D1 batch statement failed.')
        return {
            ...(result.meta?.changes === undefined ? {} : { changes: result.meta.changes }),
            rows: result.results ?? [],
        }
    })
    assertAtomicResults(statements, results)
    return results
}

const runTransaction = (
    database: Awaited<ReturnType<Database['getInstance']>>,
    statements: AtomicStatement[],
): AtomicResult[] => {
    // Native SQLite is synchronous: do not yield inside the transaction, since the app also uses this connection.
    database.exec!('BEGIN IMMEDIATE')
    try {
        const results: AtomicResult[] = []
        for (const statement of statements) {
            const prepared = database.prepare(statement.sql)
            if (statement.query) {
                results.push({ rows: prepared.all(...(statement.params ?? [])) as unknown[] })
            } else {
                const result = prepared.run(...(statement.params ?? []))
                const changes =
                    typeof result === 'object' && result !== null && 'changes' in result
                        ? Number(result.changes)
                        : undefined
                results.push(changes === undefined ? { rows: [] } : { changes, rows: [] })
            }
        }
        assertAtomicResults(statements, results)
        database.exec!('COMMIT')
        return results
    } catch (error) {
        try {
            database.exec!('ROLLBACK')
        } catch {}
        throw error
    }
}

export const runAtomic = async (database: Database, statements: AtomicStatement[]): Promise<AtomicResult[]> => {
    if (statements.length === 0) return []
    // ponytail: one lock per native connection favors correctness; split reader connections if measured contention demands it.
    return withLock(database.lockKey, async () => {
        const instance = await database.getInstance()
        if (isD1Database(instance)) return runD1Batch(instance, statements)
        if (database.dialect !== 'sqlite') {
            throw new SiteAdminError(
                'SITE_ADMIN_DATABASE_UNSUPPORTED',
                'Site Admin requires SQLite transactions or the native Cloudflare D1 batch API.',
            )
        }
        return runTransaction(instance, statements)
    })
}

export const queryRows = async <Row extends object>(
    database: Database,
    sql: string,
    params: Primitive[] = [],
): Promise<Row[]> => withLock(database.lockKey, async () => (await database.prepare(sql).all(...params)) as Row[])
