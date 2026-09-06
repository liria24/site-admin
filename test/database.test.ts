import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database, type Primitive } from 'db0'
import cloudflareD1 from 'db0/connectors/cloudflare-d1'
import nodeSqlite from 'db0/connectors/node-sqlite'

import { queryRows, runAtomic } from '../packages/site-admin/src/server/database'

const databases: Database[] = []

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

describe('atomic database execution', () => {
    it('rolls back a failed SQLite mutation', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        await database.exec('CREATE TABLE values_table (value TEXT PRIMARY KEY)')

        await expect(
            runAtomic(database, [
                { params: ['kept-out'], sql: 'INSERT INTO values_table(value) VALUES (?)' },
                { params: ['kept-out'], sql: 'INSERT INTO values_table(value) VALUES (?)' },
            ]),
        ).rejects.toThrow()
        expect(await queryRows(database, 'SELECT * FROM values_table')).toEqual([])
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
            runAtomic(database, [
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
})
