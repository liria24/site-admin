import type { Database, Primitive } from 'db0'

import { SiteAdminError } from '../errors'

export interface AtomicStatement {
    expectRow?: boolean
    params?: Primitive[]
    query?: boolean
    sql: string
}

export interface AtomicResult {
    changes?: number
    rows: unknown[]
}

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

const assertExpectedRows = (statements: AtomicStatement[], results: AtomicResult[]): void => {
    for (const [index, statement] of statements.entries()) {
        if (statement.expectRow && results[index]?.rows.length === 0) {
            throw new SiteAdminError(
                'SITE_ADMIN_CONFLICT',
                'The entry changed before this mutation committed.',
            )
        }
    }
}

const runD1Batch = async (database: Database, statements: AtomicStatement[]): Promise<AtomicResult[]> => {
    const instance = await database.getInstance()
    if (!isD1Database(instance)) {
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            'The configured D1 connector has no batch API.',
        )
    }
    const prepared = statements.map((statement) =>
        instance.prepare(statement.sql).bind(...(statement.params ?? [])),
    )
    const raw = await instance.batch(prepared)
    const results = raw.map((result) => {
        if (result.success === false || result.error)
            throw new Error(result.error ?? 'D1 batch statement failed.')
        return {
            ...(result.meta?.changes === undefined ? {} : { changes: result.meta.changes }),
            rows: result.results ?? [],
        }
    })
    assertExpectedRows(statements, results)
    return results
}

const runTransaction = async (database: Database, statements: AtomicStatement[]): Promise<AtomicResult[]> =>
    withLock(database, async () => {
        await database.exec('BEGIN IMMEDIATE')
        try {
            const results: AtomicResult[] = []
            for (const statement of statements) {
                const prepared = database.prepare(statement.sql)
                if (statement.query) {
                    results.push({ rows: await prepared.all(...(statement.params ?? [])) })
                } else {
                    const result = await prepared.run(...(statement.params ?? []))
                    const changes =
                        typeof result === 'object' && result !== null && 'changes' in result
                            ? Number(result.changes)
                            : undefined
                    results.push(changes === undefined ? { rows: [] } : { changes, rows: [] })
                }
            }
            assertExpectedRows(statements, results)
            await database.exec('COMMIT')
            return results
        } catch (error) {
            try {
                await database.exec('ROLLBACK')
            } catch {}
            throw error
        }
    })

export const runAtomic = async (
    database: Database,
    statements: AtomicStatement[],
): Promise<AtomicResult[]> => {
    if (statements.length === 0) return []
    if (database.connector === 'cloudflare-d1') return runD1Batch(database, statements)
    if (database.dialect !== 'sqlite' || !database.capabilities.transactions) {
        throw new SiteAdminError(
            'SITE_ADMIN_DATABASE_UNSUPPORTED',
            'Site Admin requires SQLite transactions or the native Cloudflare D1 batch API.',
        )
    }
    return runTransaction(database, statements)
}

export const queryRows = async <Row extends object>(
    database: Database,
    sql: string,
    params: Primitive[] = [],
): Promise<Row[]> => (await database.prepare(sql).all(...params)) as Row[]

export const queryRow = async <Row extends object>(
    database: Database,
    sql: string,
    params: Primitive[] = [],
): Promise<Row | undefined> => (await database.prepare(sql).get(...params)) as Row | undefined
