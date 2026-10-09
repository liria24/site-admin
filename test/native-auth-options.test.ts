import { describe, expect, it } from 'vitest'
import { betterAuth } from 'better-auth'
import { admin, createAccessControl, username } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { generateCombinedSchema } from '../packages/site-admin/src/generate'
import { extendSiteAdminAuth } from '../packages/site-admin/src/runtime/auth'

const resources = { 'siteAdmin:model:posts': ['readDraft', 'update'] }
const permissions = {
    admin: resources,
    editor: { 'siteAdmin:model:posts': ['readDraft'] },
    user: { 'siteAdmin:model:posts': [] },
}

describe('native admin configuration preservation', () => {
    it('retains native schema/options and writes users with an independent app admin module copy', async () => {
        const directory = await mkdtemp(resolve('test/.native-admin-'))
        const database = new DatabaseSync(':memory:')
        try {
            const pluginEntry = createRequire(import.meta.url).resolve('better-auth/plugins/admin')
            const original = new URL('./admin.mjs', pathToFileURL(pluginEntry))
            const requireNative = createRequire(original)
            const source = (await readFile(original, 'utf8')).replace(
                /from "([^"]+)"/gu,
                (match, specifier: string) => {
                    if (specifier === './schema.mjs') return match
                    const target = specifier.startsWith('.')
                        ? new URL(specifier, original)
                        : pathToFileURL(requireNative.resolve(specifier))
                    return `from ${JSON.stringify(target.href)}`
                },
            )
            await writeFile(resolve(directory, 'admin.mjs'), source)
            await writeFile(resolve(directory, 'schema.mjs'), await readFile(new URL('./schema.mjs', original)))
            const appAdmin = (await import(pathToFileURL(resolve(directory, 'admin.mjs')).href)).admin as typeof admin
            const ac = createAccessControl({ user: ['list'], session: ['revoke'], reports: ['read'] })
            const native = appAdmin({
                schema: { user: { fields: { role: 'accessRole' } } },
                defaultRole: 'editor',
                adminRoles: ['superuser'],
                adminUserIds: ['native-admin'],
                defaultBanReason: 'app ban',
                bannedUserMessage: 'app refusal',
                impersonationSessionDuration: 17,
                ac,
                roles: {
                    superuser: ac.newRole({ user: ['list'], session: ['revoke'], reports: ['read'] }),
                    editor: ac.newRole({ reports: ['read'] }),
                    user: ac.newRole({}),
                },
            })
            const other = username()
            const config = defineSiteAdminConfig({ models: { posts: { fields: { title: text() } } } })
            const schemaSource = await generateCombinedSchema(config, {
                database: drizzleAdapter({}, { provider: 'sqlite' }),
                plugins: [native, other],
            })
            expect(schemaSource).toContain('accessRole: text("access_role")')
            expect(schemaSource).not.toContain('role: text("role")')
            const schemaFile = resolve(directory, 'schema.ts')
            await writeFile(schemaFile, schemaSource)
            const migrationDirectory = resolve(directory, 'migrations')
            execFileSync(
                process.execPath,
                [
                    resolve('packages/site-admin/node_modules/drizzle-kit/bin.cjs'),
                    'generate',
                    '--dialect=sqlite',
                    `--schema=${schemaFile.replaceAll('\\', '/')}`,
                    `--out=${migrationDirectory.replaceAll('\\', '/')}`,
                ],
                { stdio: 'pipe' },
            )
            const migration = (await readdir(migrationDirectory)).find((name) => !name.startsWith('.'))!
            database.exec(await readFile(resolve(migrationDirectory, migration, 'migration.sql'), 'utf8'))
            const schema = await createJiti(import.meta.url, { fsCache: false }).import<Record<string, unknown>>(
                schemaFile,
            )
            const extended = extendSiteAdminAuth(
                {
                    database: drizzleAdapter(drizzle({ client: database }), { provider: 'sqlite', schema }),
                    secret: 'synthetic-native-admin-test-secret-at-least-32',
                    baseURL: 'https://native-admin.test',
                    plugins: [native, other],
                },
                resources,
                permissions,
            )
            expect(extended.plugins.map((plugin) => plugin.id)).toEqual(['username', 'admin'])
            expect(extended.plugins[0]).toBe(other)
            const runtime = extended.plugins.at(-1)! as ReturnType<typeof admin>
            expect(runtime.schema.user.fields.role.fieldName).toBe('accessRole')
            expect(runtime.options).toMatchObject({
                schema: native.options.schema,
                defaultRole: 'editor',
                adminRoles: ['superuser'],
                adminUserIds: ['native-admin'],
                defaultBanReason: 'app ban',
                bannedUserMessage: 'app refusal',
                impersonationSessionDuration: 17,
            })
            expect(runtime.options.roles!.editor!.statements).toMatchObject({
                reports: ['read'],
                ...permissions.editor,
            })
            expect(runtime.options.roles!.superuser!.statements).toMatchObject({
                user: ['list'],
                session: ['revoke'],
                reports: ['read'],
            })
            expect(runtime.options.roles!.admin!.statements.user).toBeUndefined()
            const auth = betterAuth(extended)
            expect(auth.api.isUsernameAvailable).toBeTypeOf('function')
            expect(auth.api.userHasPermission).toBeTypeOf('function')
            const context = await auth.$context
            const user = await context.internalAdapter.createUser(
                { name: 'Synthetic user', email: 'synthetic@native-admin.test' },
                { method: 'email-password' },
            )
            expect(user.role).toBe('editor')
            expect(database.prepare('SELECT access_role FROM user WHERE id = ?').get(user.id)).toMatchObject({
                access_role: 'editor',
            })
        } finally {
            database.close()
            await rm(directory, { recursive: true, force: true })
        }
    })

    it('adds native defaults only when absent and rejects duplicate admin instances', () => {
        const extended = extendSiteAdminAuth({ plugins: [] }, resources, permissions)
        expect(extended.plugins.map(({ id }) => id)).toEqual(['admin'])
        expect(extended.plugins[0]!.options.roles!.admin!.statements.user).toContain('list')
        expect(extended.plugins[0]!.options.roles!.user!.statements.user).toEqual([])
        expect(() => extendSiteAdminAuth({ plugins: [admin(), admin()] }, resources, permissions)).toThrow(
            'single native',
        )
    })
})
