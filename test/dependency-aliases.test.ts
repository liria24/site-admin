import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { describe, expect, it } from 'vitest'

import {
    assertSiteAdminDependencyAliasConflicts,
    createSiteAdminDependencyPlugin,
    createSiteAdminDependencyTypePaths,
    createSiteAdminDependencyAliases,
    removeSiteAdminDependencyAliases,
    siteAdminDependencyModules,
} from '../packages/site-admin/src/dependency-aliases'

describe('Site Admin owned dependency namespaces', () => {
    it('provides only the intentional major namespaces and preserves native private IDs', async () => {
        expect(Object.keys(siteAdminDependencyModules)).toEqual([
            '#better-auth',
            '#nuxtjs/better-auth',
            '#nuxt-files-sdk',
            '#files-sdk',
            '#comark',
            '#comark-content',
            '#ai',
        ])
        const plugin = createSiteAdminDependencyPlugin()
        const context = { resolve: async () => ({ id: '/owned/entry.mjs', external: false }) }
        for (const id of [
            '#auth/server',
            '#drizzle-orm',
            '#drizzle-orm/sqlite-core',
            '#better-auth/plugins/username',
            '#comark/plugins/emoji',
            '#comark/vue',
            '#better-auth/nitro-compat',
            '#better-auth/app-secret',
            '#nuxt-files-sdk/snapshot',
            '#nuxt-files-sdk/files',
        ]) {
            expect(await plugin.resolveId.call(context, id)).toBeNull()
        }
        const calls: unknown[][] = []
        const result = { id: '/owned/browser.mjs', external: false }
        expect(
            await plugin.resolveId.call(
                {
                    resolve: async (...args) => {
                        calls.push(args)
                        return result
                    },
                },
                '#better-auth/client/plugins',
            ),
        ).toBe(result)
        expect(calls[0]?.[0]).toBe('better-auth/client/plugins')
        expect(calls[0]?.[1]).toContain('/site-admin/src/dependency-aliases.ts')
        expect(calls[0]?.[2]).toEqual({ skipSelf: true })
    })

    it('rejects consumer aliases, broad aliases and TypeScript paths without overwriting them', () => {
        for (const aliases of [
            { '#better-auth': '/app/auth.ts' },
            { '#better-auth/plugins': '/app/plugins.ts' },
            { '#nuxtjs': '/app/modules' },
            { '#files-sdk/*': ['/app/types/*'] },
            [{ find: /^#ai(?:\/|$)/u, replacement: '/app/ai' }],
            [{ find: /^#files-sdk\/r2$/u, replacement: '/app/s3' }],
            { 'better-auth': '/app/other-auth.ts' },
            { '@nuxtjs/better-auth/config': '/app/config.ts' },
            [{ find: /^files-sdk\/r2$/u, replacement: '/app/s3' }],
        ])
            expect(() => assertSiteAdminDependencyAliasConflicts(aliases)).toThrow('conflicts with existing alias')
        expect(() =>
            assertSiteAdminDependencyAliasConflicts({
                '#better-auth/nitro-compat': '/native/nitro2',
                '#better-auth/app-secret': '/native/app-secret',
                '#nuxt-files-sdk/snapshot': '/native/snapshot',
                '#auth/client': '/app/auth.ts',
                '#ai-tools': '/app/ai-tools.ts',
                '#drizzle-orm': '/app/drizzle.ts',
                'drizzle-orm/sqlite-core': '/app/schema.ts',
            }),
        ).not.toThrow()
        expect(() =>
            assertSiteAdminDependencyAliasConflicts([
                { find: /^#better-auth\/nitro-compat$/u, replacement: '/native/nitro2' },
                { find: /^#nuxt-files-sdk\/(?:snapshot|files)$/u, replacement: '/native/devtools' },
            ]),
        ).not.toThrow()
        expect(() =>
            createSiteAdminDependencyPlugin().configResolved({ resolve: { alias: [], dedupe: ['better-auth'] } }),
        ).toThrow('conflicts with resolve.dedupe better-auth')
    })

    it('resolves real Jiti config subpaths and native plugin chains without application dependencies', async () => {
        const root = await mkdtemp(resolve(tmpdir(), 'site-admin-owned-jiti-'))
        const aliases = createSiteAdminDependencyAliases({ rootDir: root })
        try {
            const config = resolve(root, 'config.ts')
            await writeFile(
                config,
                `
import { adminClient } from '#better-auth/client/plugins'
import { admin } from '#better-auth/plugins'
import { defineServerAuth } from '#nuxtjs/better-auth/config'
import { defineFilesConfig } from '#nuxt-files-sdk/config'
import { parseMarkdown } from '#comark/parse'
export default [adminClient, admin, defineServerAuth, defineFilesConfig, parseMarkdown].map(value => typeof value)
`,
            )
            expect(
                await createJiti(import.meta.url, { alias: aliases, fsCache: false, moduleCache: false }).import(
                    config,
                    {
                        default: true,
                    },
                ),
            ).toEqual(Array.from({ length: 5 }, () => 'function'))
            for (const id of ['#better-auth/cookies', '#better-auth/dist/index.mjs', '#comark/plugins/emoji']) {
                expect(() => createJiti(import.meta.url, { alias: aliases })(id)).toThrow()
            }
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('removes only generated Node entries before runtime resolution and retains private aliases', () => {
        const owned = createSiteAdminDependencyAliases()
        const native = { '#better-auth/nitro-compat': '/native/nitro2', '#nuxt-files-sdk/files': '/native/files' }
        const aliases = { ...owned, ...native, '#app': '/app' }
        expect(removeSiteAdminDependencyAliases(aliases, owned)).toEqual({ ...native, '#app': '/app' })
        expect(Object.keys(aliases)).toContain('#better-auth/client/plugins')
        const array = Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))
        expect(removeSiteAdminDependencyAliases(array, owned)).toEqual(
            Object.entries({ ...native, '#app': '/app' }).map(([find, replacement]) => ({ find, replacement })),
        )
        expect(() =>
            removeSiteAdminDependencyAliases({ ...aliases, '#better-auth': '/consumer/override' }, owned),
        ).toThrow('conflicts with existing alias')
        expect(
            removeSiteAdminDependencyAliases({ '#ai': 'C:/owner/ai/index.js' }, { '#ai': 'C:\\owner\\ai\\index.js' }),
        ).toEqual({})
    })

    it('exposes only the 24 curated entries with native declaration types', () => {
        const aliases = createSiteAdminDependencyAliases()
        const paths = createSiteAdminDependencyTypePaths()
        expect(Object.keys(aliases)).toHaveLength(24)
        expect(Object.keys(paths)).toEqual(Object.keys(aliases))
        expect(Object.keys(aliases).some((id) => id.includes('*'))).toBe(false)
        expect(paths['#better-auth']?.[0]).toMatch(/\/better-auth\/dist\/index\.d\.mts$/u)
        expect(paths['#better-auth/client/plugins']?.[0]).toMatch(/\/client\/plugins\/index\.d\.mts$/u)
        expect(paths['#nuxtjs/better-auth/config']?.[0]).toMatch(/\.d\.ts$/u)
        expect(paths['#files-sdk/r2']?.[0]).toMatch(/\.d\.ts$/u)
        expect(paths['#drizzle-orm']).toBeUndefined()
        expect(paths['#drizzle-orm/sqlite-core']).toBeUndefined()
        expect(paths['#comark/plugins/security']?.[0]).toMatch(/\.d\.ts$/u)
        expect(paths['#comark/plugins/summary']?.[0]).toMatch(/\.d\.ts$/u)
        expect(paths['#comark/plugins/emoji']).toBeUndefined()
        expect(paths['#comark/vue']).toBeUndefined()
        expect(paths['#comark-content/client']?.[0]).toMatch(/\.d\.ts$/u)
        expect(paths['#ai']?.[0]).toMatch(/\.d\.ts$/u)
        expect(paths['#better-auth/nitro-compat']).toBeUndefined()
        expect(paths['#better-auth/dist/index.mjs']).toBeUndefined()
    })

    it('keeps owner isolation and native import, require, browser and server export conditions', async () => {
        const root = await mkdtemp(resolve(tmpdir(), 'site-admin-owned-conditions-'))
        try {
            const owner = resolve(root, 'owner')
            const app = resolve(root, 'app')
            await mkdir(owner, { recursive: true })
            await mkdir(app, { recursive: true })
            const helper = resolve(owner, 'dependency-aliases.ts')
            const source = await readFile(
                new URL('../packages/site-admin/src/dependency-aliases.ts', import.meta.url),
                'utf8',
            )
            const exsolve = pathToFileURL(
                createRequire(new URL('../packages/site-admin/package.json', import.meta.url)).resolve('exsolve'),
            ).href
            await writeFile(helper, source.replace("from 'exsolve'", `from ${JSON.stringify(exsolve)}`))
            await writeFile(resolve(owner, 'package.json'), '{"name":"owned-site-admin","type":"module"}')
            await writeFile(resolve(app, 'package.json'), '{"name":"isolated-app","type":"module"}')
            for (const name of Object.values(siteAdminDependencyModules)) {
                const path = resolve(owner, 'node_modules', name)
                await mkdir(resolve(path, 'plugins'), { recursive: true })
                await writeFile(
                    resolve(path, 'package.json'),
                    JSON.stringify({
                        name,
                        type: 'module',
                        exports: {
                            '.': {
                                types: './index.d.ts',
                                browser: './browser.js',
                                import: './import.js',
                                require: './require.cjs',
                            },
                            './plugins': './plugins/public.js',
                            './plugins/*': './plugins/*.js',
                            './plugins/private': null,
                        },
                    }),
                )
                for (const condition of ['browser', 'import'])
                    await writeFile(resolve(path, `${condition}.js`), `export default 'owned-${condition}'`)
                await writeFile(resolve(path, 'require.cjs'), "module.exports = 'owned-require'")
                await writeFile(resolve(path, 'index.d.ts'), "declare const value: 'owned'; export default value")
                await writeFile(resolve(path, 'plugins/public.js'), "export const value = 'exported'")
                await writeFile(resolve(path, 'plugins/public.d.ts'), "export declare const value: 'exported'")
                await writeFile(resolve(path, 'plugins/private.js'), "export const value = 'private'")
            }
            const competing = resolve(app, 'node_modules/better-auth')
            await mkdir(competing, { recursive: true })
            await writeFile(
                resolve(competing, 'package.json'),
                '{"name":"better-auth","type":"module","exports":"./index.js"}',
            )
            await writeFile(resolve(competing, 'index.js'), "export default 'consumer-version'")
            await writeFile(resolve(app, 'config.mjs'), "import value from '#better-auth'; export default value")
            const vite = pathToFileURL(fileURLToPath(import.meta.resolve('vite-plus'))).href
            const jiti = import.meta.resolve('jiti')
            const output = execFileSync(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    `
import { createJiti } from ${JSON.stringify(jiti)}
import { build } from ${JSON.stringify(vite)}
import { createSiteAdminDependencyAliases, createSiteAdminDependencyPlugin, createSiteAdminDependencyTypePaths } from ${JSON.stringify(pathToFileURL(helper).href)}
const aliases = createSiteAdminDependencyAliases({ rootDir: ${JSON.stringify(app)} })
const imported = await createJiti(${JSON.stringify(helper)}, { alias: aliases, fsCache: false, moduleCache: false }).import(${JSON.stringify(resolve(app, 'config.mjs'))}, { default: true })
const required = await createJiti(${JSON.stringify(helper)}, { alias: createSiteAdminDependencyAliases({ conditions: ['node', 'require'] }), fsCache: false, moduleCache: false }).import(${JSON.stringify(resolve(app, 'config.mjs'))}, { default: true })
  const types = createSiteAdminDependencyTypePaths()
  const results = []
  for (const ssr of [false, true]) {
    const result = await build({ configFile: false, root: ${JSON.stringify(app)}, logLevel: 'silent', plugins: [createSiteAdminDependencyPlugin()], build: { write: false, minify: false, ssr, lib: { entry: ${JSON.stringify(resolve(app, 'config.mjs'))}, formats: ['es'] } } })
    const bundles = Array.isArray(result) ? result : [result]
    results.push(bundles.flatMap(bundle => bundle.output).find(item => item.type === 'chunk').code)
  }
  let blocked = false
  try { createJiti(${JSON.stringify(helper)}, { alias: aliases })('#better-auth/plugins/private') } catch { blocked = true }
  console.log(JSON.stringify({ imported, required, browser: results[0], server: results[1], publicType: types['#better-auth/plugins'], privateType: types['#better-auth/plugins/private'], unlistedType: types['#better-auth/plugins/public'], blocked }))
`,
                ],
                { encoding: 'utf8', cwd: app, timeout: 20_000 },
            )
            const result = JSON.parse(output.trim()) as {
                imported: string
                required: string
                browser: string
                server: string
                publicType: string[]
                privateType?: string[]
                unlistedType?: string[]
                blocked: boolean
            }
            expect(result.imported).toBe('owned-import')
            expect(result.required).toBe('owned-require')
            expect(result.browser).toContain('owned-browser')
            expect(result.server).toContain('owned-import')
            expect(result.browser + result.server).not.toContain('consumer-version')
            expect(result.publicType[0]).toContain('/owner/node_modules/better-auth/plugins/public.d.ts')
            expect(result.privateType).toBeUndefined()
            expect(result.unlistedType).toBeUndefined()
            expect(result.blocked).toBe(true)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
