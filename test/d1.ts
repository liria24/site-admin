import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { DatabaseValue } from '../packages/site-admin/src/adapters/sqlite-statements'

/** SQLite-backed D1 fixture. The production path only uses native D1 bindings. */
export const sqliteD1 = (database: DatabaseSync) => {
    const affected = database.prepare('SELECT changes() AS changes')
    class Statement {
        constructor(
            readonly sql: string,
            readonly params: SQLInputValue[] = [],
        ) {}
        bind(...params: DatabaseValue[]) {
            return new Statement(
                this.sql,
                params.map((value) => (typeof value === 'boolean' ? Number(value) : value)),
            )
        }
        execute() {
            const prepared = database.prepare(this.sql)
            const results = prepared.all(...this.params)
            const changes = affected.get()!.changes as number
            return { success: true, results, meta: { changes } }
        }
        async all() {
            return this.execute()
        }
        async run() {
            return this.execute()
        }
        async raw() {
            const prepared = database.prepare(this.sql)
            prepared.setReturnArrays(true)
            return prepared.all(...this.params)
        }
    }
    const binding = {
        prepare: (sql: string) => new Statement(sql),
        async batch(input: unknown[]) {
            const statements = input.map((statement) => {
                if (!(statement instanceof Statement)) throw new Error('Statement belongs to another D1 binding.')
                return statement
            })
            database.exec(
                statements.every(({ sql }) => /^\s*(SELECT|PRAGMA)\b/iu.test(sql)) ? 'BEGIN' : 'BEGIN IMMEDIATE',
            )
            try {
                const results = statements.map((statement) => statement.execute())
                database.exec('COMMIT')
                return results
            } catch (error) {
                database.exec('ROLLBACK')
                throw error
            }
        },
        withSession: () => binding,
    }
    return binding
}
