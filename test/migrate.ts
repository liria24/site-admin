import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Database } from 'db0'
import type { SiteAdminConfig } from '../packages/site-admin/src/config'
import { generateSiteAdminSchema } from '../packages/site-admin/src/generate'
import { createSiteAdmin as createRuntime } from '../packages/site-admin/src/server'
import { createJiti } from 'jiti'
import { createD1Database } from '../packages/site-admin/src/adapters/database'
import { sqliteD1 } from './d1'

const schemaDirectory = (source: string) =>
    resolve('.tmp/test-schema', `${createHash('sha256').update(source).digest('hex')}-${process.pid}`)

export async function testAdapter(database: Database, config: SiteAdminConfig) {
    const source = generateSiteAdminSchema(config)
    const directory = schemaDirectory(source)
    mkdirSync(directory, { recursive: true })
    const path = resolve(directory, 'schema.ts')
    writeFileSync(path, source)
    const schema = await createJiti(import.meta.url, { fsCache: false }).import<Record<string, unknown>>(path)
    const client = (await database.getInstance()) as
        | import('node:sqlite').DatabaseSync
        | Parameters<typeof createD1Database>[0]
    return createD1Database('batch' in client ? client : sqliteD1(client as import('node:sqlite').DatabaseSync), schema)
}

/** Tests explicitly apply real Drizzle Kit SQL; the runtime never creates tables. */
export async function migrateTestDatabase(database: Database, config: SiteAdminConfig): Promise<void> {
    const source = generateSiteAdminSchema(config)
    const directory = schemaDirectory(source)
    mkdirSync(directory, { recursive: true })
    const schema = resolve(directory, 'schema.ts').replaceAll('\\', '/')
    const output = resolve(directory, 'migrations').replaceAll('\\', '/')
    writeFileSync(schema, source)
    if (!existsSync(output) || !readdirSync(output).some((name) => name.endsWith('.sql'))) {
        execFileSync(
            process.execPath,
            [
                resolve('node_modules/drizzle-kit/bin.cjs'),
                'generate',
                '--dialect=sqlite',
                `--schema=${schema}`,
                `--out=${output}`,
            ],
            { stdio: 'pipe' },
        )
    }
    const existing = await database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='site_admin_entries'")
        .all()
    if (existing.length) return
    for (const migration of readdirSync(output)
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await database.exec(readFileSync(resolve(output, migration), 'utf8'))
}

export async function createMigratedTestAdmin(
    options: Omit<Parameters<typeof createRuntime>[0], 'database'> & { database: Database },
) {
    await migrateTestDatabase(options.database, options.config)
    return createRuntime({ ...options, database: await testAdapter(options.database, options.config) })
}
