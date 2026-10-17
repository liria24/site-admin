import { beforeEach, describe, expect, it, vi } from 'vitest'

const kit = vi.hoisted(() => ({
    install: vi.fn(),
    has: vi.fn(() => true),
    resolve: vi.fn<(name: string) => Promise<string | undefined>>(async () => undefined),
    templates: [] as Array<{ filename: string; getContents: () => string }>,
    handlers: [] as Array<{ route: string }>,
    nitro: {} as import('nitropack/types').NitroConfig,
    publicConfig: {} as Record<string, unknown>,
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
    createResolver: () => ({ resolve: (path: string) => path }),
    defineNuxtModule: (definition: unknown) => definition,
    hasNuxtModule: kit.has,
    tryResolveModule: kit.resolve,
    directoryToURL: (path: string) => path,
    installModule: kit.install,
}))

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
    configuration: Record<string, unknown> = {},
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
            i18n: true,
            seo: false,
            sitemap: false,
            robots: false,
            ogImage: false,
            schemaOrg: false,
            ...configuration,
        },
        {
            options: {
                rootDir: process.cwd(),
                buildDir: resolve('/app/node_modules/.cache/nuxt/.nuxt'),
                build: { templates: kit.templates },
                modules: [],
                i18n: { defaultLocale: 'ja', locales: ['ja', 'en'] },
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
        kit.install.mockReset()
        kit.has.mockReset().mockReturnValue(true)
        kit.resolve
            .mockReset()
            .mockImplementation(async (name) => (name === '@tanstack/vue-form' ? undefined : consumerModulePath))
        kit.nitro = {}
        kit.publicConfig = {}
    })

    it('delegates native dependency setup to Nuxt moduleDependencies', async () => {
        await setup(false)
        expect(kit.install).not.toHaveBeenCalled()
    })

    it('removes database-backed LLMS prerenders after native module registration', async () => {
        const hook = await setup(false)
        const done = hook.mock.calls.find(([name]) => name === 'modules:done')?.[1] as () => void
        done()
        const filter = hook.mock.calls.find(([name]) => name === 'prerender:routes')?.[1] as (context: {
            routes: Set<string>
        }) => void
        const routes = new Set(['/llms.txt', '/llms-full.txt', '/application-page'])
        filter({ routes })
        expect([...routes]).toEqual(['/application-page'])
    })

    it('registers matching server/client permissions and a request-scoped database provider', async () => {
        const hook = await setup(true, undefined, (config) => {
            config.authorization = {
                roles: {
                    admin: { models: { '*': ['update'], posts: ['readDraft'] } },
                    user: { ai: ['*'] },
                    editor: { models: { '*': ['readDraft'] }, ai: ['proofread'] },
                },
            }
        })
        const { stripTypeScriptTypes } = await vi.importActual<typeof import('node:module')>('node:module')
        const executable = (filename: string) =>
            stripTypeScriptTypes(kit.templates.find((item) => item.filename === filename)!.getContents())
                .replace(/^import .*$/gmu, '')
                .replace('export default ', 'return ')
        const server = new Function('extendSiteAdminAuth', executable('site-admin/better-auth-server-plugin.ts'))(
            (
                options: unknown,
                resources: Record<string, string[]>,
                permissions: Record<string, Record<string, string[]>>,
            ) => ({ options, resources, permissions }),
        )
        const { resources, permissions } = server({ plugins: [] })
        const client = new Function(
            'createAccessControl',
            'adminClient',
            executable('site-admin/better-auth-client-plugin.mjs'),
        )(
            (statements: unknown) => ({ statements, newRole: (role: unknown) => role }),
            (options: unknown) => options,
        )
        expect(client.ac.statements).toEqual(resources)
        expect(client.roles).toEqual(permissions)
        expect(Object.keys(client.roles)).toEqual(['admin', 'user', 'editor'])
        expect(permissions.admin?.['siteAdmin:model:posts']).toEqual(['update', 'readDraft'])
        expect(permissions.admin?.user).toEqual([])
        expect(permissions.user?.['siteAdmin:ai']).toEqual(['proofread', 'plain'])
        expect(permissions.editor?.['siteAdmin:ai']).toEqual(['proofread'])

        const providerHook = hook.mock.calls.find(([name]) => name === 'better-auth:database:providers')![1]
        const providers: Record<string, { buildDatabaseCode: () => string }> = {}
        providerHook(providers)
        const providerSource = providers.siteAdmin!.buildDatabaseCode()
        const database = { kind: 'better-auth' }
        const context = {}
        const factory = vi.fn(() => database)
        const createDatabase = new Function(
            'createAuthDatabase',
            'schema',
            providerSource
                .replace(/^import .*$/gmu, '')
                .replace(/^export \{.*$/gmu, '')
                .replace('export const createDatabase', 'const createDatabase') + '\nreturn createDatabase',
        )(factory, {})
        expect(createDatabase({ context })).toBe(database)
        expect(factory).toHaveBeenCalledWith({}, {}, context)

        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(kit.handlers.some((handler) => 'middleware' in handler && handler.middleware)).toBe(true)
        expect(runtime).toContain('await getRequestSession(getNitroRequest(event))')
        expect(runtime).toContain('if (!session) return null')
        expect(kit.handlers.some(({ route }) => route === '/api/site-admin/**')).toBe(true)
    })

    it('uses the same Void database for CMS and native auth', async () => {
        const hook = await setup(true)
        expect(hook.mock.calls.some(([name]) => name === 'better-auth:database:providers')).toBe(true)
        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(runtime).toContain('useVoidDatabase(schema)')
        expect(runtime).not.toContain('domainConfig.database')
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
        expect(await Promise.resolve(early.getContents())).toContain("from 'better-auth/api'")
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
        expect(await template.getContents()).toContain("from 'better-auth/db'")
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

    it('does not open a database during unrelated requests or auth initialization', async () => {
        await setup(true)
        const source = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        const expression = source.match(/initializeRequest: (.+),\n/u)![1]
        const nativeEvents = new WeakMap()
        const run = new Function('nativeEvents', 'return (' + expression + ')')(nativeEvents)
        const event = { req: new Request('https://example.test/unrelated'), context: {} }
        await run(event)
        expect(nativeEvents.get(event.context)).toBe(event)
        expect(expression).not.toContain('Database')
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

    it('leaves app aliases and TypeScript paths alone', async () => {
        const typescript = { tsConfig: { compilerOptions: { paths: { '#ai': ['./app-ai.ts'] } } } }
        await setup(false, undefined, undefined, typescript, { '#ai': '/app-ai.ts' })
        expect(typescript.tsConfig.compilerOptions.paths).toEqual({ '#ai': ['./app-ai.ts'] })
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

it('registers automatic SEO when route resolution and legacy metadata are disabled', async () => {
    kit.templates.length = 0
    await setup(
        false,
        undefined,
        undefined,
        { tsConfig: {} },
        {},
        { seo: true, routing: { enabled: false, metadata: false } },
    )
    expect(kit.templates.some(({ filename }) => filename === 'site-admin/metadata-plugin.mjs')).toBe(true)
    expect(kit.templates.some(({ filename }) => filename === 'site-admin/route-middleware.mjs')).toBe(false)
})
