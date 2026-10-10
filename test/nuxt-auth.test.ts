import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:module', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:module')>()
    const { fileURLToPath } = await import('node:url')
    return {
        findPackageJSON: (path: string | URL) =>
            String(path) === new URL('/consumer/module.mjs', import.meta.url).href
                ? fileURLToPath(new URL('/consumer/package.json', import.meta.url))
                : original.findPackageJSON(path),
    }
})

const kit = vi.hoisted(() => ({
    install: vi.fn(),
    has: vi.fn(() => true),
    resolve: vi.fn<() => Promise<string | undefined>>(async () => undefined),
    templates: [] as Array<{ filename: string; getContents: () => string }>,
    handlers: [] as Array<{ route: string }>,
    nitro: {} as import('nitropack/types').NitroConfig,
    publicConfig: {} as Record<string, unknown>,
    plugins: [] as Array<
        ReturnType<typeof import('../packages/site-admin/src/dependency-aliases').createSiteAdminDependencyPlugin>
    >,
}))
vi.mock('nuxt/kit', () => ({
    addImports: vi.fn(),
    addPlugin: vi.fn(),
    addRouteMiddleware: vi.fn(),
    addServerImports: vi.fn(),
    addServerPlugin: vi.fn(),
    addServerHandler: (handler: { route: string }) => kit.handlers.push(handler),
    addTemplate: (template: { filename: string; getContents: () => string }) => {
        kit.templates.push(template)
        return { dst: template.filename }
    },
    addTypeTemplate: vi.fn(),
    addVitePlugin: (plugin: (typeof kit.plugins)[number]) => kit.plugins.push(plugin),
    createResolver: () => ({ resolve: (path: string) => path }),
    defineNuxtModule: (definition: unknown) => definition,
    hasNuxtModule: kit.has,
    tryResolveModule: kit.resolve,
    directoryToURL: (path: string) => path,
    installModule: kit.install,
}))

vi.mock('../packages/site-admin/src/nuxt/files-source', async (importOriginal) => {
    const original = await importOriginal<typeof import('../packages/site-admin/src/nuxt/files-source')>()
    return { ...original, resolveSiteAdminFilesModulePath: () => fileURLToPath(import.meta.resolve('nuxt-files-sdk')) }
})

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import module from '../packages/site-admin/src/nuxt'

const consumerModulePath = fileURLToPath(new URL('/consumer/module.mjs', import.meta.url))

const setup = async (
    auth: boolean,
    assets?: { storage: string },
    onConfig?: (config: import('../packages/site-admin/src/config').SiteAdminConfig) => void,
    typescript: Record<string, unknown> = { tsConfig: {} },
    aliases: Record<string, string> = {},
) => {
    const definition = module as unknown as {
        defaults: Record<string, unknown>
        setup: (options: unknown, nuxt: unknown) => Promise<void>
    }
    const hook = vi.fn()
    await definition.setup(
        {
            ...definition.defaults,
            auth,
            ...(assets ? { assets } : {}),
            configFile: './test/fixtures/nuxt/site-admin.config.ts',
            i18n: false,
            seo: false,
            sitemap: false,
            robots: false,
            ogImage: false,
            schemaOrg: false,
        },
        {
            options: {
                rootDir: process.cwd(),
                buildDir: resolve('/app/node_modules/.cache/nuxt/.nuxt'),
                build: { templates: kit.templates },
                modules: [],
                files: { config: './test/fixtures/nuxt/files.config.ts' },
                modulesDir: [],
                alias: { '@liria24/site-admin': `${process.cwd()}/packages/site-admin/src/index.ts`, ...aliases },
                typescript,
                optimization: { keyedComposables: [] },
                runtimeConfig: { public: kit.publicConfig },
                nitro: kit.nitro,
                dev: false,
            },
            callHook: vi.fn((_name, config) => onConfig?.(config)),
            hook,
            hooks: {
                afterEach: (callback: unknown) => {
                    hook('afterEach', callback)
                    return vi.fn()
                },
            },
        },
    )
    return hook
}

describe('native Better Auth integration', () => {
    beforeEach(() => {
        kit.handlers.length = 0
        kit.templates.length = 0
        kit.plugins.length = 0
        kit.install.mockReset()
        kit.has.mockReset().mockReturnValue(true)
        kit.resolve.mockReset().mockResolvedValue(undefined)
        kit.nitro = {}
        kit.publicConfig = {}
    })

    it('prefers consumer modules, falls back only on resolution failure, and preserves setup errors', async () => {
        kit.has.mockReturnValue(false)
        kit.resolve.mockResolvedValue(consumerModulePath)
        await setup(false)
        expect(kit.install.mock.calls[0]?.[0]).toBe(consumerModulePath)
        expect(kit.install.mock.calls.at(-1)?.[1]).toEqual({
            config: resolve('test/fixtures/nuxt/files.config.ts'),
        })
        kit.resolve.mockResolvedValue(undefined)
        await setup(false)
        expect(kit.install.mock.calls.some(([path]) => String(path).includes('nuxt-llms'))).toBe(true)
        kit.install.mockRejectedValueOnce(new Error('consumer module failed'))
        await expect(setup(false)).rejects.toThrow('consumer module failed')
    })

    it('registers matching server/client permissions and a request-scoped database provider', async () => {
        const hook = await setup(true, undefined, (config) => {
            delete config.database
        })
        const filenames = kit.templates.map(({ filename }) => filename)
        expect(filenames).toContain('site-admin/better-auth-server-plugin.ts')
        expect(filenames).toContain('site-admin/better-auth-client-plugin.mjs')
        expect(
            kit.templates
                .find(({ filename }) => filename === 'site-admin/better-auth-client-plugin.mjs')!
                .getContents(),
        ).toContain('adminClient({ ac, roles })')

        const providerHook = hook.mock.calls.find(([name]) => name === 'better-auth:database:providers')![1]
        const providers: Record<string, { buildDatabaseCode: () => string }> = {}
        providerHook(providers)
        const providerSource = providers.siteAdmin!.buildDatabaseCode()
        const database = { kind: 'better-auth' }
        const context = {}
        const createDatabase = new Function(
            'useSiteAdminRuntime',
            `${providerSource
                .replace(/import[^\n]+\n/u, '')
                .replace('export const db = undefined', '')
                .replace('export function createDatabase', 'function createDatabase')}\nreturn createDatabase`,
        )(() => ({ authDatabase: (value: object) => (value === context ? database : undefined) }))
        expect(createDatabase({ context })).toBe(database)
        expect(() => createDatabase({ context: {} })).toThrow('authDatabase')

        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(kit.handlers.some((handler) => 'middleware' in handler && handler.middleware)).toBe(true)
        expect(runtime).toContain('await getRequestSession(getNitroRequest(event))')
        expect(runtime).toContain('if (!session) return null')
        expect(kit.handlers.some(({ route }) => route === '/api/site-admin/**')).toBe(true)
    })

    it('leaves application-owned auth providers intact with a direct content adapter resolver', async () => {
        const hook = await setup(true)
        expect(hook.mock.calls.some(([name]) => name === 'better-auth:database:providers')).toBe(false)
        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(runtime).toContain('resolveSiteAdminDatabase(context.database ?? domainConfig.database')
        expect(runtime).not.toContain('database-sqlite')
        expect(runtime).not.toContain('database-d1')
    })

    it('extends the effective native factory after module setup without adding a second server admin', async () => {
        const hook = await setup(
            true,
            undefined,
            undefined,
            { tsConfig: {} },
            { '#auth/server': '/app/extended-auth.ts' },
        )
        const sources = { server: ['/app/other-plugin.ts'], client: ['/app/client-plugin.ts'] }
        hook.mock.calls.find(([name]) => name === 'better-auth:plugins:extend')![1](sources)
        expect(sources.server).toEqual(['/app/other-plugin.ts'])
        expect(sources.client).toEqual(['/app/client-plugin.ts', 'site-admin/better-auth-client-plugin.mjs'])
        const early = {
            filename: 'types/nuxt-better-auth-endpoints.d.ts',
            getContents: () =>
                "import type createServerAuth from '/app/extended-auth.ts'\nimport type { getEndpoints } from 'better-auth/api'",
        }
        kit.templates.push(early)
        await hook.mock.calls.find(([name]) => name === 'afterEach')![1]({ name: 'modules:done' })
        expect(await Promise.resolve(early.getContents())).toContain(
            'import type createServerAuth from "site-admin/better-auth-server-config.ts"',
        )
        expect(await Promise.resolve(early.getContents())).not.toContain("from 'better-auth/api'")
        expect(await Promise.resolve(early.getContents())).toMatch(/better-auth\/dist\/api\/index\.d\.mts/u)
        const wrapper = kit.templates.find(({ filename }) => filename === 'site-admin/better-auth-server-config.ts')!
        expect(wrapper.getContents()).toContain('import createAuth from "/app/extended-auth.ts"')
        expect(wrapper.getContents()).toContain('Parameters<typeof createAuth>[0]')
        expect(wrapper.getContents()).toContain('extendAuth(createAuth(context))')
        const template: { filename: string; getContents: () => string | Promise<string> } = {
            filename: 'types/nuxt-better-auth-infer.d.ts',
            getContents: () =>
                "import type createServerAuth from '/app/extended-auth.ts'\nimport type { BetterAuthOptions } from 'better-auth'\nimport type { InferFieldsOutput } from 'better-auth/db'\nexport type Config = ReturnType<typeof createServerAuth>",
        }
        const templatesHook = hook.mock.calls.find(([name]) => name === 'app:templates')![1]
        templatesHook({ templates: [template] })
        const rewritten = template.getContents
        expect(await template.getContents()).toContain(
            'import type createServerAuth from "site-admin/better-auth-server-config.ts"',
        )
        expect(await template.getContents()).not.toMatch(/from ['"]better-auth(?:\/db)?['"]/u)
        expect(await template.getContents()).toMatch(/better-auth\/dist\/db\/index\.d\.mts/u)
        templatesHook({ templates: [template] })
        expect(template.getContents).toBe(rewritten)
        const config: import('nitropack/types').NitroConfig = { esbuild: { options: { exclude: /node_modules/u } } }
        for (const [name, callback] of hook.mock.calls) if (name === 'nitro:config') callback(config)
        const filters = config.esbuild!.options!.exclude as RegExp[]
        expect(
            filters.every(
                (filter) =>
                    !filter.test(
                        resolve('/app/node_modules/.cache/nuxt/.nuxt/site-admin/better-auth-server-config.ts'),
                    ),
            ),
        ).toBe(true)
        expect(filters.some((filter) => filter.test('/app/node_modules/better-auth/dist/index.mjs'))).toBe(true)
    })

    it('serializes only approved SEO defaults and rules into public config', async () => {
        await setup(false, undefined, (config) => {
            config.seo = { titleTemplate: '%s | Public', image: false }
            config.routeRules = { '/ja/posts/**': { seo: { type: 'article' }, sitemap: false } }
            Object.assign(config.seo, { secret: 'SERVER_ONLY_GLOBAL_SENTINEL', callback: () => 'PRIVATE' })
            Object.assign(config.routeRules['/ja/posts/**']!, { database: 'SERVER_ONLY_RULE_SENTINEL' })
        })
        expect(kit.publicConfig.siteAdmin).toEqual({
            seo: { titleTemplate: '%s | Public', image: false },
            routeRules: { '/ja/posts/**': { seo: { type: 'article' }, sitemap: false } },
        })
        expect(JSON.stringify(kit.publicConfig)).not.toContain('SERVER_ONLY')
    })

    it('enables authentication and i18n by default', () => {
        const definition = module as unknown as { defaults: { auth: boolean; i18n: boolean } }
        expect(definition.defaults.auth).toBe(true)
        expect(definition.defaults.i18n).toBe(true)
    })

    it('rejects dependency namespace paths in every public TypeScript context', async () => {
        for (const name of ['tsConfig', 'appTsConfig', 'nodeTsConfig', 'sharedTsConfig', 'serverTsConfig']) {
            await expect(
                setup(false, undefined, undefined, {
                    tsConfig: {},
                    [name]: { compilerOptions: { paths: { '#ai': ['./custom-ai.ts'] } } },
                }),
            ).rejects.toThrow('conflicts with existing alias #ai')
        }
    })

    it('types native auth config imports and preserves Nitro declaration extensions', async () => {
        const hook = await setup(
            true,
            undefined,
            undefined,
            { tsConfig: {} },
            {
                '#auth/client': '/generated/auth-client.ts',
                '#auth/server': '/generated/auth-server.ts',
            },
        )
        const instance = {
            options: {
                buildDir: '/generated',
                typescript: { tsconfigPath: 'types/tsconfig.json' },
                exportConditions: ['node', 'import'],
            },
            hooks: { hook: vi.fn() },
        }
        hook.mock.calls.find(([name]) => name === 'nitro:init')![1](instance)
        const types = {
            tsConfig: { compilerOptions: { paths: { '#other': ['./untouched'] } as Record<string, string[]> } },
        }
        instance.hooks.hook.mock.calls.find(([name]) => name === 'types:extend')![1](types)
        expect(types.tsConfig.compilerOptions.paths['#better-auth']?.[0]).toMatch(/index\.d\.mts$/u)
        expect(types.tsConfig.compilerOptions.paths['#better-auth/plugins']?.[0]).toMatch(/index\.d\.mts$/u)
        expect(types.tsConfig.compilerOptions.paths['@nuxtjs/better-auth/config']).toEqual(
            types.tsConfig.compilerOptions.paths['#nuxtjs/better-auth/config'],
        )
        expect(types.tsConfig.compilerOptions.paths['#other']).toEqual(['./untouched'])
    })

    it('does not include authentication or management HTTP when disabled', async () => {
        await setup(false)
        expect(kit.templates.some(({ filename }) => filename.includes('better-auth'))).toBe(false)
        expect(kit.handlers.some(({ route }) => route === '/api/site-admin/**')).toBe(false)
        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(runtime).not.toContain('getRequestSession')
        expect(runtime).not.toContain("hooks.hook('request', resolveDatabases)")
    })

    it('serializes effective common-config and hook asset policy', async () => {
        await setup(false, undefined, (config) => {
            expect(config.assets?.storage).toBe('content')
            expect(config.assets?.maxUploadSize).toBe(123)
            config.assets!.storage = 'hook'
        })
        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(runtime).toContain('"storage":"hook"')
        expect(runtime).toContain('"maxUploadSize":123')
        const plugin = (kit.nitro.rollupConfig!.plugins as Array<unknown>).at(-1) as {
            transform: (code: string, id: string) => { code: string; map: null }
        }
        expect(
            plugin
                .transform(
                    'body = Buffer.from(await request.arrayBuffer());',
                    '/nitropack/dist/presets/cloudflare/runtime/_module-handler.mjs',
                )
                .code.trim(),
        ).toBe('body = request.body;')
    })
})
