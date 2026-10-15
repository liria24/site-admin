import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { withRuntimeEnv } from 'void/_env'
import { useVoidDatabase, createAuthDatabase } from '../packages/site-admin/src/runtime/database'
import { sqliteD1 } from './d1'

const connections: DatabaseSync[] = []
afterEach(() => {
    for (const database of connections.splice(0)) database.close()
})
const binding = (name: string) => {
    const database = new DatabaseSync(':memory:')
    connections.push(database)
    database.exec('CREATE TABLE probe (name TEXT)')
    database.prepare('INSERT INTO probe VALUES (?)').run(name)
    return sqliteD1(database)
}

it('reuses storage for the same native binding and schema while retaining request isolation', async () => {
    const first = binding('first'),
        second = binding('second'),
        schema = {}
    const run = (DB: ReturnType<typeof binding>) =>
        withRuntimeEnv({ DB }, async () => {
            const storage = useVoidDatabase(schema)
            expect(useVoidDatabase(schema)).toBe(storage)
            await Promise.resolve()
            return { storage, values: await storage.query('SELECT name FROM probe') }
        })
    const [one, two] = await Promise.all([run(first), run(second)])
    expect(one.values).toEqual([{ name: 'first' }])
    expect(two.values).toEqual([{ name: 'second' }])
    expect(one.storage).not.toBe(two.storage)
    expect((await run(first)).storage).toBe(one.storage)
    withRuntimeEnv({ DB: first }, () => expect(useVoidDatabase({})).not.toBe(one.storage))
})

it('uses a fresh Void session across requests without caching a request-bound native client', async () => {
    const DB = binding('one'),
        schema = {}
    let sessions = 0
    const session = DB.withSession
    DB.withSession = () => {
        sessions++
        return session()
    }
    const run = () =>
        withRuntimeEnv({ DB }, async () => {
            const storage = useVoidDatabase(schema)
            await storage.query('SELECT name FROM probe')
            await storage.query('SELECT name FROM probe')
        })
    await run()
    expect(sessions).toBe(1)
    await run()
    expect(sessions).toBe(2)
})

it('rejects missing D1 bindings and keeps auth preparation independent from CMS schema initialization', () => {
    withRuntimeEnv({}, () => expect(() => useVoidDatabase({})).toThrow('Void with a D1'))
    const auth = createAuthDatabase({})({})
    expect(auth.id).toBe('drizzle')
    expect(auth.findOne).toBeTypeOf('function')
})
