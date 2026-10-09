import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { join } from 'pathe'
import { DatabaseSync } from 'node:sqlite'
import { createJiti } from 'jiti'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { admin } from 'better-auth/plugins'
import type { BetterAuthOptions } from 'better-auth'
import { drizzleAdapter } from '../packages/site-admin/src/adapters/drizzle'
import { generateCombinedSchema } from '../packages/site-admin/src/generate'
import {
    resolveSiteAdminDatabase,
    type SiteAdminDatabaseConfig,
    type SiteAdminDatabaseContext,
} from '../packages/site-admin/src/runtime/database'
import { createMemoryDatabase } from './memory-storage'
import { resolveSiteAdminConfig } from '../packages/site-admin/src/config-resolution'
import { createSiteAdmin } from '../packages/site-admin/src/server'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'

const directories: string[] = []
const connections: DatabaseSync[] = []
afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close()
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const adapter = () => {
    const database = createMemoryDatabase()
    return { ...database, bind: vi.fn((config: Parameters<typeof database.bind>[0]) => database.bind(config)) }
}

describe('application-owned database resolution', () => {
    it('keeps the native auth fixture database lazy during config and schema inspection', async () => {
        await mkdir(resolve('.tmp'), { recursive: true })
        const path = await mkdtemp(resolve('.tmp/native-auth-database-'))
        directories.push(path)
        const driver = resolve(path, 'driver.mjs')
        const schema = resolve(path, 'schema.mjs')
        await writeFile(driver, 'export const drizzle = () => { throw new Error("Application driver requested") }\n')
        await writeFile(schema, 'export const authRelations = {}\n')
        const jiti = createJiti(import.meta.url, {
            alias: {
                'drizzle-orm/node-sqlite': driver,
                '../.data/schema/schema': schema,
                // Unit tests run before package build; the fixture keeps its public app import.
                '@liria24/site-admin/adapters/drizzle': resolve('packages/site-admin/src/adapters/drizzle.ts'),
            },
            fsCache: false,
            moduleCache: false,
        })
        const createAuth = await jiti.import<
            (context: {
                requestOrigin?: string
                db: undefined
                runtimeConfig: Record<string, unknown>
            }) => BetterAuthOptions
        >(resolve('test/fixtures/nuxt/server/auth.config.ts'), { default: true })
        expect(createAuth({ db: undefined, runtimeConfig: {} })).not.toHaveProperty('database')
        expect(() => createAuth({ db: undefined, runtimeConfig: {}, requestOrigin: 'https://example.test' })).toThrow(
            'Application driver requested',
        )
    })

    it('returns the supplied adapter unchanged without opening, closing, querying, or binding it', async () => {
        const database = Object.assign(adapter(), { open: vi.fn(), close: vi.fn() })
        expect(await resolveSiteAdminDatabase(database)).toBe(database)
        expect(database.open).not.toHaveBeenCalled()
        expect(database.close).not.toHaveBeenCalled()
        expect(database.bind).not.toHaveBeenCalled()
    })

    it('awaits app resolvers and preserves native request and event-free platform context identity', async () => {
        const first = adapter()
        const second = adapter()
        const request = new Request('https://example.test/content')
        const event = { req: request, context: { cloudflare: { env: { DB: {} } } } }
        const requestContext = { request, event }
        const platformContext = { cloudflare: { env: { DB: {} }, context: {} } }
        const taskContext = { platformContext }
        const resolver = vi.fn(async (context: SiteAdminDatabaseContext) => (context.event ? first : second))
        expect(await resolveSiteAdminDatabase(resolver, requestContext)).toBe(first)
        expect(await resolveSiteAdminDatabase(resolver, taskContext)).toBe(second)
        expect(resolver).toHaveBeenNthCalledWith(1, requestContext)
        expect(resolver).toHaveBeenNthCalledWith(2, taskContext)
        expect(taskContext).not.toHaveProperty('event')
        expect(taskContext).not.toHaveProperty('request')
        const failure = new Error('Application binding is unavailable')
        await expect(resolveSiteAdminDatabase(() => Promise.reject(failure), taskContext)).rejects.toBe(failure)
    })

    it('rejects missing or legacy connection configuration instead of choosing a driver or binding', async () => {
        for (const value of [
            undefined,
            null,
            {},
            { connector: 'sqlite', schema: 'schema.ts' },
            { connector: 'd1', binding: 'DB' },
        ])
            await expect(resolveSiteAdminDatabase(value as SiteAdminDatabaseConfig)).rejects.toMatchObject({
                code: 'SITE_ADMIN_DATABASE_UNSUPPORTED',
            })
    })

    it('keeps environment-selected adapters opaque, complete, and identical to the app object', () => {
        const development = adapter()
        const production = adapter()
        const input = defineSiteAdminConfig({
            database: development,
            models: {},
            $production: { database: production },
        })
        expect(resolveSiteAdminConfig(input, ['development']).database).toBe(development)
        expect(resolveSiteAdminConfig(input, ['production']).database).toBe(production)
    })

    it('leaves migrations to the app and shares the app Drizzle connection with native Better Auth', async () => {
        const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
        await mkdir(resolve('.tmp'), { recursive: true })
        const path = await mkdtemp(resolve('.tmp/app-database-'))
        directories.push(path)
        const schemaPath = join(path, 'schema.ts')
        const appDatabaseFactory = vi.fn(() => {
            throw new Error('Schema generation must not call the app database factory.')
        })
        await writeFile(schemaPath, await generateCombinedSchema(config, { database: appDatabaseFactory }))
        expect(appDatabaseFactory).not.toHaveBeenCalled()
        const schema = await createJiti(import.meta.url, { fsCache: false }).import<Record<string, unknown>>(schemaPath)
        const client = new DatabaseSync(':memory:')
        connections.push(client)
        const applicationDb = drizzle({ client, relations: schema.authRelations as never })
        const applicationAdapter = drizzleAdapter(applicationDb, { schema })
        const database = await resolveSiteAdminDatabase(() => applicationAdapter)
        expect(await applicationAdapter.query("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([])
        await expect(createSiteAdmin({ config, database }).initialize()).rejects.toMatchObject({
            code: 'SITE_ADMIN_MIGRATION_REQUIRED',
        })
        expect(await applicationAdapter.query("SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([])
        const output = join(path, 'migrations')
        execFileSync(
            process.execPath,
            [
                resolve('packages/site-admin/node_modules/drizzle-kit/bin.cjs'),
                'generate',
                '--dialect=sqlite',
                `--schema=${schemaPath}`,
                `--out=${output}`,
            ],
            { stdio: 'pipe' },
        )
        const migration = (await readdir(output)).find((name) => !name.startsWith('.'))!
        client.exec(await readFile(resolve(output, migration, 'migration.sql'), 'utf8'))
        expect(
            (await createSiteAdmin({ config, database }).createEntry('posts', { data: { title: 'App-owned' } })).data,
        ).toEqual({ title: 'App-owned' })
        const auth = authAdapter(applicationDb, { provider: 'sqlite', schema, transaction: false })({
            plugins: [admin()],
        })
        await auth.create({
            model: 'user',
            data: {
                name: 'Application user',
                email: 'app@example.test',
                emailVerified: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        })
        expect(await applicationAdapter.query('SELECT email FROM user')).toEqual([{ email: 'app@example.test' }])
        expect(await applicationAdapter.query('SELECT 1 AS value')).toEqual([{ value: 1 }])
    })
})
