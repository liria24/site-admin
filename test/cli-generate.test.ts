import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const cli = resolve('packages/site-admin/src/cli.ts')
const jiti = resolve('node_modules/jiti/lib/jiti-cli.mjs')
const fields = resolve('packages/site-admin/src/fields.ts')

describe('environment-resolved schema CLI', () => {
    it('uses the common environment resolver and configured schema path without opening SQLite or D1', async () => {
        await mkdir(resolve('.tmp'), { recursive: true })
        const path = await mkdtemp(resolve('.tmp/cli-generate-'))
        try {
            await writeFile(
                resolve(path, 'site-admin.config.ts'),
                `import { text } from ${JSON.stringify(fields)}
export default {
  database: { connector: 'sqlite', schema: 'schema-base.ts', filename: 'never-open.sqlite' },
  models: { posts: { fields: { title: text() } } },
  $development: { database: { schema: 'schema-development.ts' } },
  $production: {
    database: { connector: 'd1', schema: 'schema-production.ts', binding: 'NEVER_RESOLVE', authUsePlural: true },
    models: { posts: { fields: { title: text({ required: true }) } } },
  },
  $env: { preview: {
    database: { schema: 'schema-preview.ts' },
    models: { previews: { fields: { note: text() } } },
  } },
  $prerender: { database: { schema: 'schema-prerender.ts' } },
}
`,
            )
            const run = (environment: string, args: string[] = []) =>
                execFileSync(process.execPath, [jiti, cli, 'generate', ...args], {
                    cwd: path,
                    env: { ...process.env, NODE_ENV: environment },
                    encoding: 'utf8',
                })
            expect(run('development')).toContain('no database was modified')
            expect(await readFile(resolve(path, 'schema-development.ts'), 'utf8')).not.toContain(
                'text("field_title").notNull()',
            )
            run('production')
            expect(await readFile(resolve(path, 'schema-production.ts'), 'utf8')).toContain(
                'text("field_title").notNull()',
            )
            run('production', ['--env', 'preview'])
            const preview = await readFile(resolve(path, 'schema-preview.ts'), 'utf8')
            expect(preview).toContain('site_admin_content_previews')
            expect(preview).toContain('text("field_title").notNull()')
            run('production', ['--env', 'preview', '--prerender'])
            expect(await readFile(resolve(path, 'schema-prerender.ts'), 'utf8')).toBe(preview)
            run('production', ['--out', 'explicit/schema.ts'])
            expect(await readFile(resolve(path, 'explicit/schema.ts'), 'utf8')).toContain(
                'text("field_title").notNull()',
            )
            await writeFile(resolve(path, 'auth.config.ts'), 'export default {}\n')
            run('production', ['--auth', 'auth.config.ts', '--out', 'schema-auth.ts'])
            expect(await readFile(resolve(path, 'schema-auth.ts'), 'utf8')).toContain(
                'export const users = sqliteTable',
            )
            expect(await readdir(path)).not.toContain('never-open.sqlite')
            expect(await readdir(path)).not.toContain('migrations')
        } finally {
            await rm(path, { recursive: true, force: true })
        }
    })
})
