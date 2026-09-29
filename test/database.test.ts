import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database, type Primitive } from 'db0'
import cloudflareD1 from 'db0/connectors/cloudflare-d1'
import nodeSqlite from 'db0/connectors/node-sqlite'

import { queryRows, runAtomic } from '../packages/site-admin/src/server/database'
import { testAdapter } from './migrate'
import { drizzleAdapter, type DrizzleConnection } from '../packages/site-admin/src/adapters/drizzle'
import {
    queryRows as nativeQueryRows,
    runAtomic as nativeRunAtomic,
} from '../packages/site-admin/src/adapters/drizzle-database'

const databases: Database[] = []

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

describe('atomic database execution', () => {
    it('rejects connections without an atomic native client', () => {
        expect(() => drizzleAdapter({ $client: {}, insert: () => undefined }, { schema: {} })).toThrow('transactional')
    })

    it('serializes reads behind a transaction on the same Database instance', async () => {
        const order: string[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        const fake = {
            lockKey: {},
            capabilities: { transactions: true },
            connector: 'test',
            dialect: 'sqlite',
            getInstance: () => ({
                prepare: () => ({
                    bind() {
                        return this
                    },
                }),
                batch: async () => {
                    order.push('batch')
                    await gate
                    order.push('commit')
                    return [{ results: [] }]
                },
            }),
            prepare: (sql: string) => ({
                all: async () => {
                    order.push(`all:${sql}`)
                    return []
                },
                get: async () => undefined,
                run: async () => ({ changes: 1 }),
            }),
        } as unknown as DrizzleConnection
        const mutation = nativeRunAtomic(fake, [{ query: true, sql: 'SELECT mutation' }])
        await Promise.resolve()
        const read = nativeQueryRows(fake, 'SELECT read')
        await Promise.resolve()
        expect(order).toEqual(['batch'])
        release()
        await Promise.all([mutation, read])
        expect(order).toEqual(['batch', 'commit', 'all:SELECT read'])
    })

    it('rolls back a failed SQLite mutation', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        await database.exec('CREATE TABLE values_table (value TEXT PRIMARY KEY)')

        await expect(
            runAtomic(await testAdapter(database, { models: {} }), [
                { params: ['kept-out'], sql: 'INSERT INTO values_table(value) VALUES (?)' },
                { params: ['kept-out'], sql: 'INSERT INTO values_table(value) VALUES (?)' },
            ]),
        ).rejects.toThrow()
        expect(await queryRows(await testAdapter(database, { models: {} }), 'SELECT * FROM values_table')).toEqual([])
    })

    it('uses one native D1 batch and checks RETURNING guards', async () => {
        class Statement {
            readonly params: Primitive[] = []

            constructor(readonly sql: string) {}

            bind(...params: Primitive[]): Statement {
                this.params.push(...params)
                return this
            }
        }

        const batches: Statement[][] = []
        const binding = {
            batch: async (statements: Statement[]) => {
                batches.push(statements)
                return statements.map(() => ({ results: [], success: true }))
            },
            exec: async () => ({ count: 0, duration: 0 }),
            prepare: (sql: string) => new Statement(sql),
        }
        Object.assign(globalThis, { __env__: { SITE_ADMIN_TEST_DB: binding } })
        const database = createDatabase(cloudflareD1({ bindingName: 'SITE_ADMIN_TEST_DB' }))
        databases.push(database)

        await expect(
            runAtomic(await testAdapter(database, { models: {} }), [
                { params: ['a'], sql: 'INSERT INTO example(value) VALUES (?)' },
                { expectRow: true, query: true, sql: 'UPDATE example SET value = value RETURNING value' },
            ]),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        expect(batches).toHaveLength(1)
        expect(batches[0]?.map((statement) => statement.sql)).toEqual([
            'INSERT INTO example(value) VALUES (?)',
            'UPDATE example SET value = value RETURNING value',
        ])
    })

    it('does not roll back unrelated application work on the shared SQLite connection', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        const adapter = await testAdapter(database, { models: {} })
        const native = (await database.getInstance()) as import('node:sqlite').DatabaseSync
        native.exec('CREATE TABLE values_table (value TEXT PRIMARY KEY)')
        const exec = native.exec.bind(native)
        native.exec = (sql) => {
            exec(sql)
            if (sql === 'BEGIN IMMEDIATE')
                queueMicrotask(() => native.prepare("INSERT INTO values_table VALUES ('application')").run())
        }
        await expect(
            runAtomic(adapter, [
                { sql: "INSERT INTO values_table VALUES ('content')" },
                { sql: "INSERT INTO values_table VALUES ('content')" },
            ]),
        ).rejects.toThrow()
        expect(await queryRows(adapter, 'SELECT value FROM values_table')).toEqual([{ value: 'application' }])
    })
})
