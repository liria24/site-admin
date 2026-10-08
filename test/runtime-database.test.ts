import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createJiti } from 'jiti'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { admin } from 'better-auth/plugins'
import { generateCombinedSchema, generateSiteAdminSchema } from '../packages/site-admin/src/generate'
import { createSQLiteDatabaseResolver } from '../packages/site-admin/src/runtime/database-sqlite'
import { createD1DatabaseResolver } from '../packages/site-admin/src/runtime/database-d1'
import { finalizeSiteAdminDatabases, type SiteAdminDatabaseResolver } from '../packages/site-admin/src/runtime/database'
import { createSiteAdmin } from '../packages/site-admin/src/server'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'

const directories: string[] = []
const resolvers: SiteAdminDatabaseResolver[] = []
afterEach(async () => {
    for (const resolver of resolvers.splice(0)) resolver.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const directory = async () => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const path = await mkdtemp(resolve('.tmp/runtime-database-'))
    directories.push(path)
    return path
}

const loadSchema = async (path: string, source: string) => {
    await writeFile(resolve(path, 'schema.ts'), source)
    return createJiti(import.meta.url, { fsCache: false }).import<Record<string, unknown>>(resolve(path, 'schema.ts'))
}

/** Test-only DDL: explicitly apply application-generated Drizzle migrations. */
const applyMigrations = async (path: string, filename: string) => {
    const output = resolve(path, 'migrations')
    execFileSync(
        process.execPath,
        [
            resolve('packages/site-admin/node_modules/drizzle-kit/bin.cjs'),
            'generate',
            '--dialect=sqlite',
            `--schema=${resolve(path, 'schema.ts')}`,
            `--out=${output}`,
        ],
        { stdio: 'pipe' },
    )
    const migration = (await readdir(output)).find((name) => !name.startsWith('.'))!
    const database = new DatabaseSync(filename)
    try {
        database.exec(await readFile(resolve(output, migration, 'migration.sql'), 'utf8'))
    } finally {
        database.close()
    }
}

describe('module-owned database resolution', () => {
    it('preserves advanced database overrides without opening or mixing built-in connections', async () => {
        const builtIn = createSQLiteDatabaseResolver({ filename: ':memory:', schema: {}, auth: true })
        resolvers.push(builtIn)
        const application = createSQLiteDatabaseResolver({ filename: ':memory:', schema: {}, auth: true })
        resolvers.push(application)
        const resolved = await application.resolve()
        const builtinResolve = vi.spyOn(builtIn, 'resolve')
        const context = { ...resolved, event: { context: {} }, platformContext: { cloudflare: { env: {} } } }
        expect(await finalizeSiteAdminDatabases(context, builtIn, { requireAuth: true })).toBe(context)
        expect(context.database).toBe(resolved.database)
        expect(context.authDatabase).toBe(resolved.authDatabase)
        expect(builtinResolve).not.toHaveBeenCalled()
        await expect(
            finalizeSiteAdminDatabases({ database: resolved.database }, builtIn, { requireAuth: true }),
        ).rejects.toThrow('same connection')
        await expect(finalizeSiteAdminDatabases({ authDatabase: resolved.authDatabase }, builtIn)).rejects.toThrow(
            'also provide database',
        )
        expect(builtinResolve).not.toHaveBeenCalled()
        const platformContext = { cloudflare: { env: {} } }
        const empty = {}
        expect(await finalizeSiteAdminDatabases(empty, builtIn, { platformContext, requireAuth: true })).toBe(empty)
        expect(builtinResolve).toHaveBeenCalledExactlyOnceWith(platformContext)
        await expect(finalizeSiteAdminDatabases({})).rejects.toThrow('SQLite/D1')
    })

    it('shares one SQLite/Auth connection and requires explicitly applied migrations', async () => {
        const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
        const path = await directory()
        const schema = await loadSchema(path, await generateCombinedSchema(config, {}, { usePlural: true }))
        const filename = resolve(path, 'nested/site-admin.sqlite')
        const resolver = createSQLiteDatabaseResolver({ filename, schema, auth: true, authUsePlural: true })
        resolvers.push(resolver)
        const [first, second] = await Promise.all([resolver.resolve({}), resolver.resolve({})])
        expect(first).toBe(second)
        expect(await first.database.query("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([])
        await expect(createSiteAdmin({ config, database: first.database }).initialize()).rejects.toMatchObject({
            code: 'SITE_ADMIN_MIGRATION_REQUIRED',
        })
        expect(await first.database.query("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([])
        await applyMigrations(path, filename)
        const site = createSiteAdmin({ config, database: first.database })
        expect((await site.createEntry('posts', { data: { title: 'Module database' } })).data).toEqual({
            title: 'Module database',
        })
        const authDatabase = first.authDatabase
        if (typeof authDatabase !== 'function') throw new Error('Expected the built-in Better Auth adapter.')
        const adapter = authDatabase({ plugins: [admin()] })
        const created = await adapter.create({
            model: 'user',
            data: {
                name: 'Module user',
                email: 'module@example.test',
                emailVerified: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        })
        expect(created).toMatchObject({ email: 'module@example.test' })
        expect(await first.database.query('SELECT email FROM users')).toEqual([{ email: 'module@example.test' }])
        resolver.close()
        await expect(first.database.query('SELECT 1')).rejects.toThrow()
        await expect(resolver.resolve()).rejects.toThrow('closed')
    })

    it('uses D1 request and task bindings, isolates connections, and never creates schema or owns the binding', async () => {
        const path = await directory()
        const schema = await loadSchema(path, generateSiteAdminSchema({ models: {} }))
        const binding = () => ({
            prepare: vi.fn((sql: string) => ({
                bind: (...params: unknown[]) => ({ all: async () => ({ results: [{ sql, params }] }) }),
            })),
            batch: vi.fn(async () => []),
            close: vi.fn(),
        })
        const firstBinding = binding()
        const secondBinding = binding()
        const resolver = createD1DatabaseResolver({ binding: 'CONTENT_DB', schema, auth: true })
        resolvers.push(resolver)
        const first = await resolver.resolve({ cloudflare: { env: { CONTENT_DB: firstBinding } } })
        const task = await resolver.resolve({ cloudflare: { env: { CONTENT_DB: firstBinding }, context: {} } })
        const second = await resolver.resolve({ cloudflare: { env: { CONTENT_DB: secondBinding } } })
        expect(task).toBe(first)
        expect(second.database).not.toBe(first.database)
        expect(first.authDatabase).toBeTypeOf('function')
        expect(firstBinding.prepare).not.toHaveBeenCalled()
        expect(firstBinding.batch).not.toHaveBeenCalled()
        expect(await first.database.query('SELECT ?', ['bound'])).toEqual([{ sql: 'SELECT ?', params: ['bound'] }])
        await expect(resolver.resolve()).rejects.toMatchObject({ code: 'SITE_ADMIN_DATABASE_UNSUPPORTED' })
        await expect(resolver.resolve({ cloudflare: { env: { WRONG: firstBinding } } })).rejects.toThrow('CONTENT_DB')
        await expect(resolver.resolve({ cloudflare: { env: { CONTENT_DB: {} } } })).rejects.toThrow('CONTENT_DB')
        resolver.close()
        expect(firstBinding.close).not.toHaveBeenCalled()
        expect((await resolver.resolve({ cloudflare: { env: { CONTENT_DB: firstBinding } } })).database).not.toBe(
            first.database,
        )
    })
})
