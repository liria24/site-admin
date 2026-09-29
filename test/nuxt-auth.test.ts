import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:module', () => ({ findPackageJSON: () => '/consumer/package.json' }))

const kit = vi.hoisted(() => ({
    install: vi.fn(),
    has: vi.fn(() => true),
    resolve: vi.fn<() => Promise<string | undefined>>(async () => undefined),
    templates: [] as Array<{ filename: string; getContents: () => string }>,
    handlers: [] as Array<{ route: string }>,
    nitro: {} as import('nitropack/types').NitroConfig,
}))
vi.mock('@nuxt/kit', () => ({
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

import module from '../packages/site-admin/src/nuxt'

const setup = async (
    auth: boolean,
    assets?: { storage: string },
    onConfig?: (config: import('../packages/site-admin/src/config').SiteAdminConfig) => void,
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
                modulesDir: [],
                alias: { '@liria24/site-admin': `${process.cwd()}/packages/site-admin/src/index.ts` },
                nitro: kit.nitro,
                dev: false,
            },
            callHook: vi.fn((_name, config) => onConfig?.(config)),
            hook,
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
        kit.resolve.mockReset().mockResolvedValue(undefined)
        kit.nitro = {}
    })

    it('prefers consumer modules, falls back only on resolution failure, and preserves setup errors', async () => {
        kit.has.mockReturnValue(false)
        kit.resolve.mockResolvedValue('/consumer/module.mjs')
        await setup(false)
        expect(kit.install.mock.calls[0]?.[0]).toBe('/consumer/module.mjs')
        kit.resolve.mockResolvedValue(undefined)
        await setup(false)
        expect(kit.install.mock.calls.some(([path]) => String(path).includes('nuxt-llms'))).toBe(true)
        kit.install.mockRejectedValueOnce(new Error('consumer module failed'))
        await expect(setup(false)).rejects.toThrow('consumer module failed')
    })

    it('registers matching server/client permissions and a request-scoped database provider', async () => {
        const hook = await setup(true)
        const filenames = kit.templates.map(({ filename }) => filename)
        expect(filenames).toContain('site-admin/better-auth-server-plugin.mjs')
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
        const createDatabase = new Function(
            `${providerSource.replace('export const db = undefined', '').replace('export function createDatabase', 'function createDatabase')}\nreturn createDatabase`,
        )()
        const database = { kind: 'better-auth' }
        const key = Symbol.for('@liria24/site-admin/request-databases')
        expect(createDatabase({ context: { [key]: { authDatabase: database } } })).toBe(database)
        expect(() => createDatabase({ context: {} })).toThrow('authDatabase')

        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(runtime).toContain("nitroApp.hooks.hook('request', resolveDatabases)")
        expect(runtime).toContain('await getRequestSession(event)')
        expect(runtime).toContain('if (!session) return null')
        expect(kit.handlers.some(({ route }) => route === '/api/site-admin/**')).toBe(true)
    })

    it('enables authentication and i18n by default', () => {
        const definition = module as unknown as { defaults: { auth: boolean; i18n: boolean } }
        expect(definition.defaults.auth).toBe(true)
        expect(definition.defaults.i18n).toBe(true)
    })

    it('does not include authentication or management HTTP when disabled', async () => {
        await setup(false)
        expect(kit.templates.some(({ filename }) => filename.includes('better-auth'))).toBe(false)
        expect(kit.handlers.some(({ route }) => route === '/api/site-admin/**')).toBe(false)
        const runtime = kit.templates.find(({ filename }) => filename === 'site-admin/runtime.mjs')!.getContents()
        expect(runtime).not.toContain('getRequestSession')
        expect(runtime).not.toContain("hooks.hook('request', resolveDatabases)")
    })

    it('serializes effective domain/module/hook asset settings', async () => {
        await setup(false, { storage: 'module' }, (config) => {
            expect(config.assets?.storage).toBe('module')
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
