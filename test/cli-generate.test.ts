import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const cli = resolve('packages/site-admin/src/cli.ts')
const jiti = resolve('node_modules/jiti/lib/jiti-cli.mjs')
const fields = resolve('packages/site-admin/src/fields.ts')

describe('environment-resolved schema CLI', () => {
    it('resolves domain environments and explicit output without invoking the application database', async () => {
        await mkdir(resolve('.tmp'), { recursive: true })
        const path = await mkdtemp(resolve('.tmp/cli-generate-'))
        try {
            await writeFile(
                resolve(path, 'site-admin.config.ts'),
                `import { text } from ${JSON.stringify(fields)}
import { getProvider } from '#files-sdk/providers'
if (!getProvider('memory')) throw new Error('CLI native Files alias failed')
export default {
  database: () => { throw new Error('The CLI must not invoke the application database') },
  models: { posts: { fields: { title: text() } } },
  $production: {
    database: () => { throw new Error('The CLI must not resolve a production database') },
    models: { posts: { fields: { title: text({ required: true }) } } },
  },
  $env: { preview: {
    models: { previews: { fields: { note: text() } } },
  } },
  $prerender: { models: { prerenders: { fields: { note: text() } } } },
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
            expect(await readFile(resolve(path, 'schema.ts'), 'utf8')).not.toContain('text("field_title").notNull()')
            run('production', ['--out', 'schema-production.ts'])
            expect(await readFile(resolve(path, 'schema-production.ts'), 'utf8')).toContain(
                'text("field_title").notNull()',
            )
            run('production', ['--env', 'preview', '--out', 'schema-preview.ts'])
            const preview = await readFile(resolve(path, 'schema-preview.ts'), 'utf8')
            expect(preview).toContain('site_admin_content_previews')
            expect(preview).toContain('text("field_title").notNull()')
            run('production', ['--env', 'preview', '--prerender', '--out', 'schema-prerender.ts'])
            expect(await readFile(resolve(path, 'schema-prerender.ts'), 'utf8')).toContain(
                'site_admin_content_prerenders',
            )
            run('production', ['--out', 'explicit/schema.ts'])
            expect(await readFile(resolve(path, 'explicit/schema.ts'), 'utf8')).toContain(
                'text("field_title").notNull()',
            )
            await writeFile(resolve(path, 'auth.config.ts'), 'export default {}\n')
            run('production', ['--auth', 'auth.config.ts', '--out', 'schema-auth.ts'])
            expect(await readFile(resolve(path, 'schema-auth.ts'), 'utf8')).toContain('export const user = sqliteTable')
            run('production', ['--auth', 'auth.config.ts', '--auth-use-plural', '--out', 'schema-auth-plural.ts'])
            expect(await readFile(resolve(path, 'schema-auth-plural.ts'), 'utf8')).toContain(
                'export const users = sqliteTable',
            )
            expect(await readdir(path)).not.toContain('never-open.sqlite')
            expect(await readdir(path)).not.toContain('migrations')
        } finally {
            await rm(path, { recursive: true, force: true })
        }
    })
})
