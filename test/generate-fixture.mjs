import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateCombinedSchema } from '../packages/site-admin/dist/generate.js'

export async function generateFixtureSQL(config, directory, plugins = []) {
    await mkdir(directory, { recursive: true })
    const schema = resolve(directory, 'schema.ts').replaceAll('\\', '/')
    const source = await generateCombinedSchema(config, {
        emailAndPassword: { enabled: true },
        plugins,
    })
    const output = resolve(
        directory,
        'migrations-' + createHash('sha256').update(source).digest('hex').slice(0, 16),
    ).replaceAll('\\', '/')
    await writeFile(schema, source)
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
    const migrations = (await readdir(output)).filter((name) => name.endsWith('.sql')).toSorted()
    return (await Promise.all(migrations.map((name) => readFile(resolve(output, name), 'utf8')))).join('\n')
}
