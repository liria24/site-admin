import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateCombinedSchema } from '../packages/site-admin/dist/generate.js'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'

export async function generateFixtureSQL(config, directory, plugins = []) {
    await mkdir(directory, { recursive: true })
    const schema = resolve(directory, 'schema.ts').replaceAll('\\', '/')
    const output = resolve(directory, 'migrations').replaceAll('\\', '/')
    await writeFile(
        schema,
        await generateCombinedSchema(config, {
            database: drizzleAdapter({}, { provider: 'sqlite', transaction: false }),
            emailAndPassword: { enabled: true },
            plugins,
        }),
    )
    execFileSync(
        process.execPath,
        [
            resolve('packages/site-admin/node_modules/drizzle-kit/bin.cjs'),
            'generate',
            '--dialect=sqlite',
            `--schema=${schema}`,
            `--out=${output}`,
        ],
        { stdio: 'pipe' },
    )
    const migrations = (await readdir(output)).filter((name) => !name.startsWith('.')).toSorted()
    return (await Promise.all(migrations.map((name) => readFile(resolve(output, name, 'migration.sql'), 'utf8')))).join(
        '\n',
    )
}
