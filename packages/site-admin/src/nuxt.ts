import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { normalize } from 'pathe'

import {
    addImports,
    addPlugin,
    addRouteMiddleware,
    addServerHandler,
    addServerImports,
    addServerPlugin,
    addTemplate,
    addTypeTemplate,
    createResolver,
    defineNuxtModule,
    hasNuxtModule,
    installModule,
    tryResolveModule,
    directoryToURL,
} from 'nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import type { AppSession } from '@nuxtjs/better-auth'
import type { RequestEvent } from 'nuxt/server'
import { transformNitroCloudflareRequest } from './runtime/nitro2'
import { stopNitroDevReloadOnClose } from './nuxt/dev-close'
import {
    siteAdminFilesModuleDependencies,
    resolveSiteAdminFilesSource,
    allowGeneratedFilesConfig,
} from './nuxt/files-source'
import type { NitroConfig } from 'nitropack/types'
import { createJiti } from 'jiti'
import type { ModuleOptions as NuxtLLMsOptions } from 'nuxt-llms'
import type { SiteAdminDatabaseScopeContext } from './runtime/database'

import type { SiteAdminConfig, SiteAdminConfigInput, SiteAdminLifecycleEvent } from './config'
import type { EntryPrepareContext } from './model'
import type { AnyField } from './fields'
import { resolveSiteAdminConfig } from './config-resolution'
import { serializeSiteAdminSeo, serializeSiteAdminRouteRules } from './seo'
import { resolveSiteAdminAssets } from './assets-config'
import {
    siteAdminNuxtClientTemplate,
    siteAdminNuxtFormTemplate,
    siteAdminNuxtModelTypes,
    siteAdminNuxtSeoTemplate,
} from './nuxt/client-templates'
import type { SiteAdminActor } from './server/types'
import { moduleMeta } from './meta'
import { siteAdminNuxtMetadataTemplate, siteAdminNuxtRouteTemplate } from './nuxt/route-templates'

export interface ModuleOptions {
    ai?: boolean
    auth: boolean
    client: { basePath: string; origin?: string }
    configFile: string
    devtools: boolean
    enabled: boolean
    i18n: boolean
    llms: boolean
    ogImage: boolean
    robots: boolean
    routing: { enabled: boolean; preserveHistory: boolean; redirects: boolean }
    schemaOrg: boolean
    seo: boolean
    server: { enabled: boolean; managementBase: string }
    sitemap: boolean
}

export type ModuleConfig = Omit<Partial<ModuleOptions>, 'client' | 'routing' | 'server'> & {
    client?: Partial<ModuleOptions['client']>
    routing?: Partial<ModuleOptions['routing']>
    server?: Partial<ModuleOptions['server']>
}

export interface SiteAdminAuthorizeContext {
    actor: SiteAdminActor
    event: RequestEvent
    session: AppSession
}

export type SiteAdminDatabaseContext = SiteAdminDatabaseScopeContext<RequestEvent>

// Build-time registries live on @nuxt/schema and are bridged by nuxt/schema.
declare module '@nuxt/schema' {
    interface NuxtConfig {
        llms?: Partial<NuxtLLMsOptions>
        siteAdmin?: ModuleConfig
    }

    interface NuxtOptions {
        siteAdmin: ModuleOptions
    }

    interface NuxtHooks {
        'site-admin:config': (config: SiteAdminConfig) => void | Promise<void>
    }
}

declare module 'nuxt/schema' {
    interface NuxtServerHooks {
        'site-admin:database': (context: SiteAdminDatabaseContext) => void | Promise<void>
        'site-admin:authorize': (context: SiteAdminAuthorizeContext) => void | Promise<void>
        'site-admin:entry:committed': (event: SiteAdminLifecycleEvent) => void | Promise<void>
    }
}

declare module 'nuxt/app' {
    interface RuntimeNuxtHooks {
        'site-admin:entry:prepare': (context: EntryPrepareContext) => void | Promise<void>
    }
}

const defaults: ModuleOptions = {
    auth: true,
    client: { basePath: '/api/content' },
    configFile: './site-admin.config.ts',
    devtools: true,
    enabled: true,
    i18n: true,
    llms: true,
    ogImage: true,
    robots: true,
    routing: { enabled: true, preserveHistory: true, redirects: true },
    schemaOrg: true,
    seo: true,
    server: { enabled: true, managementBase: '/api/site-admin' },
    sitemap: true,
}

const normalizeBase = (value: string, name: string): string => {
    const normalized = `/${value.split('/').filter(Boolean).join('/')}`
    if (normalized === '/' || normalized.includes('?') || normalized.includes('#')) {
        throw new Error(`[site-admin] ${name} must be a non-root URL path.`)
    }
    return normalized
}

const resolvePeer = async (name: string, nuxt: Nuxt): Promise<string> => {
    const candidate = await tryResolveModule(
        name,
        [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((dir) => resolve(dir, '..'))].map(directoryToURL),
    )
    if (!candidate)
        throw new Error(
            `[site-admin] Install the peer dependency "${name}" in your app, or disable its Site Admin integration.`,
        )
    return candidate
}

const hasMarkdown = (field: AnyField): boolean =>
    field.kind === 'markdown' ||
    (field.kind === 'object' && Object.values(field.fields).some(hasMarkdown)) ||
    (field.kind === 'array' && hasMarkdown(field.item))

const installOnce = async (name: string, nuxt: Nuxt, options: Record<string, unknown> = {}): Promise<void> => {
    if (hasNuxtModule(name, nuxt)) return
    const candidate = await resolvePeer(name, nuxt)
    // Dynamically installed SEO modules do not pass through Nuxt's moduleDependencies graph.
    if (['nuxt-schema-org', 'nuxt-seo-utils', '@nuxtjs/sitemap', '@nuxtjs/robots', 'nuxt-og-image'].includes(name)) {
        await installOnce('nuxt-site-config', nuxt)
    }
    await installModule(candidate, options, nuxt)
}

const localeOptions = (nuxt: Nuxt): { defaultLocale?: string; strategy: string; supported: string[] } => {
    const i18n = (
        nuxt.options as typeof nuxt.options & {
            i18n?: { defaultLocale?: string; locales?: Array<string | { code?: string }>; strategy?: string }
        }
    ).i18n
    const supported = (i18n?.locales ?? []).flatMap((locale) => {
        const code = typeof locale === 'string' ? locale : locale.code
        return code ? [code] : []
    })
    return {
        ...(i18n?.defaultLocale ? { defaultLocale: i18n.defaultLocale } : {}),
        strategy: i18n?.strategy ?? 'prefix_except_default',
        supported,
    }
}

const accessControl = (config: SiteAdminConfig) => {
    const modelActions = ['create', 'delete', 'publish', 'prune', 'readDraft', 'restore', 'schedule', 'sort', 'update']
    const assetActions = ['delete', 'gc', 'read', 'upload']
    const systemActions = ['diagnostics', 'publishDue']
    const resources = {
        ...Object.fromEntries(Object.keys(config.models).map((name) => [`siteAdmin:model:${name}`, modelActions])),
        'siteAdmin:assets': assetActions,
        ...(config.ai?.actions ? { 'siteAdmin:ai': Object.keys(config.ai.actions) } : {}),
        'siteAdmin:system': systemActions,
        session: ['list', 'revoke', 'delete'],
        user: [
            'create',
            'list',
            'set-role',
            'ban',
            'impersonate',
            'delete',
            'set-password',
            'set-email',
            'get',
            'update',
        ],
    }
    const custom = Object.fromEntries(
        Object.entries(config.authorization?.roles ?? {}).map(([name, role]) => {
            const statements: Record<string, readonly string[]> = {
                'siteAdmin:assets': role.assets ?? [],
                'siteAdmin:system': role.system ?? [],
                ...(config.ai?.actions
                    ? { 'siteAdmin:ai': role.ai?.includes('*') ? Object.keys(config.ai.actions) : (role.ai ?? []) }
                    : {}),
                session: [],
                user: [],
            }
            for (const model of Object.keys(config.models)) {
                statements[`siteAdmin:model:${model}`] = [
                    ...(role.models?.['*'] ?? []),
                    ...(role.models?.[model] ?? []),
                ]
            }
            return [name, statements]
        }),
    )
    const permissions = {
        admin: resources,
        user: Object.fromEntries(Object.keys(resources).map((name) => [name, []])),
        ...custom,
    }
    return {
        source: `const resources = ${JSON.stringify(resources)}\nconst permissions = ${JSON.stringify(permissions)}`,
        roleNames: Object.keys(permissions),
    }
}

const serverAccessPlugin = (
    access: ReturnType<typeof accessControl>,
): string => `import type { BetterAuthOptions } from 'better-auth'
import { extendSiteAdminAuth } from ${JSON.stringify(createResolver(import.meta.url).resolve('./runtime/auth.js'))}
${access.source}
export default <const T extends BetterAuthOptions>(options: T) => extendSiteAdminAuth(options, resources, permissions)
`

const clientAccessPlugin = (
    access: ReturnType<typeof accessControl>,
): string => `import { adminClient } from 'better-auth/client/plugins'
import { createAccessControl } from 'better-auth/plugins'
${access.source}
const ac = createAccessControl(resources)
const roles = {
  ${access.roleNames.map((name) => `${JSON.stringify(name)}: ac.newRole(permissions[${JSON.stringify(name)}]),`).join('\n  ')}
}
export default adminClient({ ac, roles })
`

const betterAuthDatabaseProvider =
    (): string => `import { useSiteAdminRuntime } from '@liria24/site-admin/internal/nuxt/server'

export const db = undefined
export function createDatabase(event) {
  const database = useSiteAdminRuntime().authDatabase?.(event?.context)
  if (!database) throw new Error('[site-admin] The site-admin:database hook must provide authDatabase when authentication is enabled.')
  return database
}
`

export default defineNuxtModule<ModuleConfig>({
    meta: moduleMeta,
    defaults,
    moduleDependencies: siteAdminFilesModuleDependencies,
    async setup(input, nuxt) {
        // Nuxt merges defaults before setup; the public input type allows nested partial options.
        const options = input as ModuleOptions
        if (!options.enabled) return
        if (nuxt.options.server?.builder && nuxt.options.server.builder !== '@nuxt/nitro-server') {
            throw new Error(
                '[site-admin] Nuxt 4.6 with the default Nitro 2 server builder is required for authentication and streaming adapters.',
            )
        }
        if (nuxt.options.dev) {
            nuxt.hook('nitro:init', stopNitroDevReloadOnClose)
        }
        addTypeTemplate(
            {
                filename: 'types/site-admin.d.ts',
                getContents: () => "import '@liria24/site-admin/nuxt'\nexport {}\n",
            },
            { nuxt: true, nitro: true, node: true },
        )
        options.client.basePath = normalizeBase(options.client.basePath, 'client.basePath')
        options.server.managementBase = normalizeBase(options.server.managementBase, 'server.managementBase')
        if (!options.server.enabled && !options.client.origin) {
            throw new Error('[site-admin] client.origin is required while server.enabled is false.')
        }
        if (options.server.enabled && options.client.basePath === options.server.managementBase) {
            throw new Error('[site-admin] Public and management API paths must differ.')
        }

        if (options.sitemap) {
            const sitemap = (nuxt.options as typeof nuxt.options & { sitemap?: { sources?: string[] } }).sitemap
            const source = `${options.client.origin ?? ''}${options.client.basePath}/_sitemap`
            if (sitemap) {
                sitemap.sources ??= []
                if (!sitemap.sources.includes(source)) sitemap.sources.push(source)
            } else {
                ;(nuxt.options as typeof nuxt.options & { sitemap: { sources: string[] } }).sitemap = {
                    sources: [source],
                }
            }
        }
        if (options.i18n) await installOnce('@nuxtjs/i18n', nuxt)
        if (options.schemaOrg) await installOnce('nuxt-schema-org', nuxt)
        if (options.llms) {
            await installOnce('nuxt-llms', nuxt)
            nuxt.hook('prerender:routes', ({ routes }) => {
                routes.delete('/llms.txt')
                routes.delete('/llms-full.txt')
            })
        }
        if (options.seo) await installOnce('nuxt-seo-utils', nuxt)
        if (options.sitemap) await installOnce('@nuxtjs/sitemap', nuxt)
        if (options.robots) await installOnce('@nuxtjs/robots', nuxt)
        if (options.ogImage) await installOnce('nuxt-og-image', nuxt)

        const publicLocales = options.i18n ? localeOptions(nuxt) : { strategy: 'no_prefix', supported: [] }

        if (options.seo || options.ogImage || options.schemaOrg) {
            const plugin = addTemplate({
                filename: 'site-admin/metadata-plugin.mjs',
                getContents: () => siteAdminNuxtMetadataTemplate(options),
                write: true,
            })
            addPlugin(plugin.dst)
        }

        const nitro = (nuxt.options as unknown as { nitro: NitroConfig }).nitro
        nitro.externals ??= {}
        // Nuxt 4.6's renderer subpaths must be bundled so Nitro replaces their build stubs.
        ;(nitro.externals.inline ??= []).push(
            '@liria24/site-admin',
            'nuxt/internal',
            resolve(nuxt.options.buildDir, 'site-admin'),
            ...(options.auth ? [resolve(nuxt.options.buildDir, 'better-auth/database.mjs')] : []),
        )

        let domainConfig: SiteAdminConfig | undefined
        let configPath: string | undefined
        let unnamedFilesStorage = false
        const environments = (nuxt.options as typeof nuxt.options & { nitro: NitroConfig }).nitro.static
            ? ['production', 'prerender']
            : [nuxt.options.envName || (nuxt.options.dev ? 'development' : 'production')]
        const requestedConfigPath = resolve(nuxt.options.rootDir, options.configFile)
        if (options.server.enabled || existsSync(requestedConfigPath)) {
            configPath = resolve(nuxt.options.rootDir, options.configFile)
            const filesPath = await resolveSiteAdminFilesSource(nuxt, options.configFile)
            const configFiles = [...new Set([configPath, filesPath, resolve(nuxt.options.rootDir, 'files.config.ts')])]
            nuxt.hook('prepare:types', ({ tsConfig }) => {
                ;(tsConfig.include ??= []).push(...configFiles)
            })
            if (nuxt.options.dev) {
                // ponytail: watch the config entrypoints; imported helpers can use Nuxt's watch option.
                nuxt.options.watch.push(...configFiles.map(normalize))
            }
            const jiti = createJiti(import.meta.url, {
                alias: nuxt.options.alias,
                fsCache: false,
                moduleCache: false,
            })
            const inputConfig = await jiti.import<SiteAdminConfigInput>(configPath, { default: true })
            domainConfig = resolveSiteAdminConfig(inputConfig, environments)
            if (Object.values(domainConfig.models).some((model) => Object.values(model.fields).some(hasMarkdown)))
                await resolvePeer('comark', nuxt)
            // An existing standalone Files config owns all physical storage settings.
            // Otherwise the SDK reads the common config through its existing filename option.
            const filesInput =
                filesPath === configPath || !(domainConfig.assets || domainConfig.storage)
                    ? inputConfig
                    : await jiti.import<SiteAdminConfigInput>(filesPath, { default: true })
            const filesConfig = resolveSiteAdminConfig(filesInput, environments)
            unnamedFilesStorage = Boolean(filesConfig.storage && 'adapter' in filesConfig.storage)
            if (domainConfig.assets) domainConfig.assets = resolveSiteAdminAssets(domainConfig.assets, filesConfig)!
            await nuxt.callHook('site-admin:config', domainConfig)
            if (options.server.enabled && (options.auth || options.llms)) {
                addServerHandler({
                    middleware: true,
                    handler: createResolver(import.meta.url).resolve('./runtime/database-middleware'),
                })
            }
            if (options.server.enabled && options.auth === true) {
                await resolvePeer('better-auth', nuxt)
                const access = accessControl(domainConfig)
                const serverAuthPlugin = addTemplate({
                    filename: 'site-admin/better-auth-server-plugin.ts',
                    getContents: () => serverAccessPlugin(access),
                    write: true,
                })
                const clientAuthPlugin = addTemplate({
                    filename: 'site-admin/better-auth-client-plugin.mjs',
                    getContents: () => clientAccessPlugin(access),
                    write: true,
                })
                nuxt.hook('better-auth:plugins:extend', (sources) => {
                    sources.client = [...(sources.client ?? []), clientAuthPlugin.dst]
                })
                // Preserve the existing custom-hook bridge only for legacy hook-only apps.
                // Direct adapter configurations leave Better Auth's app-owned provider intact.
                if (!domainConfig.database && Object.keys(domainConfig.models).length > 0) {
                    nuxt.hook('better-auth:database:providers', (providers) => {
                        providers.siteAdmin = {
                            priority: 1_000,
                            isEnabled: () => true,
                            buildDatabaseCode: betterAuthDatabaseProvider,
                        }
                    })
                }
                await installOnce('@nuxtjs/better-auth', nuxt)
                nuxt.hook('nitro:config', (nativeConfig) => {
                    const config = nativeConfig as NitroConfig
                    config.esbuild ??= {}
                    config.esbuild.options ??= {}
                    config.esbuild.options.exclude = allowGeneratedFilesConfig(
                        config.esbuild.options.exclude,
                        resolve(nuxt.options.buildDir, 'site-admin'),
                    )
                })
                // Native setup resolves the app factory and any other additive plugins first.
                // Wrapping its final factory preserves request context and the app-selected adapter.
                const stopAuthSetupObserver = nuxt.hooks.afterEach(({ name }) => {
                    if (name !== 'modules:done') return
                    stopAuthSetupObserver()
                    const source = nuxt.options.alias['#auth/server']
                    if (!source) throw new Error('[site-admin] Native Better Auth server configuration is unavailable.')
                    const serverConfig = addTemplate({
                        filename: 'site-admin/better-auth-server-config.ts',
                        getContents: () => `import createAuth from ${JSON.stringify(source)}
import extendAuth from ${JSON.stringify(serverAuthPlugin.dst)}
export default (context: Parameters<typeof createAuth>[0]) => extendAuth(createAuth(context))
`,
                        write: true,
                    })
                    nuxt.options.alias['#auth/server'] = serverConfig.dst
                    const rewritten = new WeakSet<object>()
                    const rewriteTemplates = (templates: typeof nuxt.options.build.templates) => {
                        for (const template of templates) {
                            if (
                                !(
                                    template.filename?.startsWith('types/nuxt-better-auth-') ||
                                    template.filename === 'types/auth-database.d.ts'
                                ) ||
                                !template.getContents ||
                                rewritten.has(template)
                            )
                                continue
                            rewritten.add(template)
                            const getContents = template.getContents
                            template.getContents = async (context) =>
                                (await getContents(context)).replace(
                                    `import type createServerAuth from '${source}'`,
                                    `import type createServerAuth from ${JSON.stringify(serverConfig.dst)}`,
                                )
                        }
                    }
                    // `nuxt prepare` writes types before the app template hook runs.
                    rewriteTemplates(nuxt.options.build.templates)
                    nuxt.hook('app:templates', (app) => rewriteTemplates(app.templates))
                })
            }
            if (options.server.enabled && (domainConfig.assets || domainConfig.storage)) {
                await resolvePeer('files-sdk', nuxt)
                // Optional dependency defaults cover configured module entries. Dynamic installs
                // need the same resolved single filename passed through the SDK's public option.
                await installOnce('nuxt-files-sdk', nuxt, { config: filesPath })
                nuxt.hook('nitro:config', (nativeConfig) => {
                    const config = nativeConfig as NitroConfig
                    config.esbuild ??= {}
                    config.esbuild.options ??= {}
                    config.esbuild.options.exclude = allowGeneratedFilesConfig(
                        config.esbuild.options.exclude,
                        resolve(config.buildDir ?? nuxt.options.buildDir, 'nuxt-files-sdk'),
                    )
                })
                nitro.rollupConfig ??= {}
                const existing = nitro.rollupConfig.plugins
                nitro.rollupConfig.plugins = [
                    existing,
                    {
                        name: 'site-admin-cloudflare-upload-stream',
                        transform: transformNitroCloudflareRequest,
                    },
                ]
            }
        }

        const aiEnabled = options.ai ?? Boolean(domainConfig?.ai)
        const namedAiActions = aiEnabled && Boolean(Object.keys(domainConfig?.ai?.actions ?? {}).length)
        if (namedAiActions) await resolvePeer('ai', nuxt)
        const cmsConfigured =
            !domainConfig ||
            Boolean(Object.keys(domainConfig.models).length || domainConfig.assets || domainConfig.database)
        if (options.routing.enabled && cmsConfigured) {
            const middleware = addTemplate({
                filename: 'site-admin/route-middleware.mjs',
                getContents: () => siteAdminNuxtRouteTemplate(options, publicLocales),
                write: true,
            })
            addRouteMiddleware({ global: true, name: 'site-admin-public-route', path: middleware.dst })
        }

        // Only the explicitly serializable public presentation contract enters client config.
        const publicConfig = nuxt.options.runtimeConfig.public as typeof nuxt.options.runtimeConfig.public & {
            siteAdmin?: { seo?: unknown; routeRules?: unknown }
        }
        publicConfig.siteAdmin = {
            seo: serializeSiteAdminSeo(domainConfig?.seo),
            routeRules: serializeSiteAdminRouteRules(domainConfig?.routeRules),
        }

        const clientTemplate = addTemplate({
            filename: 'site-admin/client.ts',
            getContents: () =>
                siteAdminNuxtClientTemplate({
                    basePath: options.client.basePath,
                    managementBase: options.server.managementBase,
                    i18n: options.i18n,
                    auth: options.auth,
                    aiActions: namedAiActions,
                    ...(options.client.origin ? { origin: options.client.origin } : {}),
                }),
            write: true,
        })
        nuxt.options.optimization.keyedComposables.push({
            name: 'siteAdminAsyncData',
            source: clientTemplate.dst,
            argumentLength: 3,
        })
        addImports([
            { from: clientTemplate.dst, name: 'useContent' },
            { from: clientTemplate.dst, name: 'useAdminEntries' },
            { from: clientTemplate.dst, name: 'useAdminEntry' },
            { from: clientTemplate.dst, name: 'useAdminClient' },
        ])
        if (namedAiActions) {
            nuxt.options.optimization.keyedComposables.push({
                name: 'siteAdminAiFetch',
                source: clientTemplate.dst,
                argumentLength: 3,
            })
            addImports({ from: clientTemplate.dst, name: 'useAi' })
        }
        if (options.seo || options.ogImage) {
            addTemplate({
                filename: 'site-admin/seo.ts',
                getContents: () => siteAdminNuxtSeoTemplate({ seo: options.seo, ogImage: options.ogImage }),
                write: true,
            })
        }
        if (domainConfig && configPath) {
            addTypeTemplate(
                {
                    filename: 'types/site-admin-models.d.ts',
                    getContents: () => siteAdminNuxtModelTypes(configPath!, environments),
                },
                { nuxt: true, nitro: true, node: false },
            )
            const formPeer = await tryResolveModule(
                '@tanstack/vue-form',
                [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((dir) => resolve(dir, '..'))].map(directoryToURL),
            )
            if (formPeer) {
                const formTemplate = addTemplate({
                    filename: 'site-admin/form.ts',
                    getContents: () => siteAdminNuxtFormTemplate(),
                    write: true,
                })
                addImports({ from: formTemplate.dst, name: 'useEntryForm' })
            }
        }
        if (!options.server.enabled || !domainConfig || !configPath) return
        const locales = publicLocales
        const nuxtSite = (nuxt.options as typeof nuxt.options & { site?: { name?: string; url?: string } }).site
        const site = {
            ...(typeof nuxtSite?.name === 'string' ? { name: nuxtSite.name } : {}),
            ...(typeof nuxtSite?.url === 'string' ? { url: nuxtSite.url } : {}),
        }
        const authImport = options.auth === true ? `import { getRequestSession } from '#imports'` : ''
        const authorize = options.auth
            ? `async (_request, event) => {
      if (!event) return null
      try {
        const session = await getRequestSession(getNitroRequest(event))
        if (!session) return null
        const role = session.user.role
        const roles = typeof role === 'string' ? role.split(',').map((value) => value.trim()).filter(Boolean) : []
        const context = { actor: { id: session.user.id, roles }, event, session }
        await hooks.callHook('site-admin:authorize', context)
        return context.actor
      } catch (error) {
        throw normalizeSiteAdminAuthorizationError(error)
      }
    }`
            : 'undefined'
        const filesImport = domainConfig.assets ? `import { useServerFiles } from 'nuxt-files-sdk/runtime'` : ''
        const filesOption = domainConfig.assets
            ? unnamedFilesStorage
                ? `getFiles: async (name) => {
      if (name !== 'default') throw new Error('[site-admin] Unknown storage reference for an unnamed Files storage: ' + name)
      return useServerFiles()
    },`
                : `getFiles: async (name) => useServerFiles(name),`
            : ''
        const localizePath = options.i18n
            ? `locales: {
      defaultLocale: ${JSON.stringify(locales.defaultLocale)},
      supported: ${JSON.stringify(locales.supported)},
      localizePath: (path, locale) => {
        const strategy = ${JSON.stringify(locales.strategy)}
        const defaultLocale = ${JSON.stringify(locales.defaultLocale)}
        if (strategy === 'no_prefix' || (strategy === 'prefix_except_default' && locale === defaultLocale)) return path
        return '/' + locale + (path === '/' ? '' : path)
      },
    },`
            : ''
        nitro.experimental ??= {}
        nitro.experimental.tasks = true
        nitro.tasks ??= {}
        const taskPaths = {
            publishDue: 'publish-due',
            assetGC: 'asset-gc',
            syncAssets: 'sync-assets',
        } as const
        for (const [key, name] of Object.entries(taskPaths)) {
            const task = `site-admin:${name}`
            nitro.tasks[task] = { handler: createResolver(import.meta.url).resolve(`./runtime/tasks/${name}`) }
            const schedule = domainConfig.tasks?.[key as keyof typeof taskPaths]
            if (typeof schedule === 'string') {
                if (!schedule.trim()) throw new Error(`[site-admin] ${task} requires a non-empty cron expression.`)
                nitro.scheduledTasks ??= {}
                const existing = nitro.scheduledTasks[schedule]
                const scheduled = Array.isArray(existing) ? existing : existing ? [existing] : []
                if (!scheduled.includes(task)) scheduled.push(task)
                nitro.scheduledTasks[schedule] = scheduled
            }
        }
        // Nitro skips TypeScript transforms beneath node_modules/.cache (cf build).
        // Keep this generated plugin executable JavaScript, with JSDoc for the native types.
        const runtimeTemplate = addTemplate({
            filename: 'site-admin/runtime.mjs',
            getContents: () => `import { defineNitroPlugin } from 'nitropack/runtime'
import { useServerHooks } from 'nuxt/server'
${authImport}
${filesImport}
${namedAiActions ? "import { executeSiteAdminAiAction } from '@liria24/site-admin/internal/ai'" : ''}
import { createSiteAdminDatabaseScope } from '@liria24/site-admin/internal/runtime/database'
import inputConfig from ${JSON.stringify(normalize(configPath))}
import { resolveSiteAdminConfig } from '@liria24/site-admin/internal/config-resolution'
const domainConfig = resolveSiteAdminConfig(inputConfig, ${JSON.stringify(environments)})
delete domainConfig.storage
delete domainConfig.routes
import { createSiteAdmin } from '@liria24/site-admin/internal/server'
import { configureSiteAdminRuntime, normalizeSiteAdminAuthorizationError } from '@liria24/site-admin/internal/nuxt/server'
import { captureNitroRequest, getNitroRequest } from '@liria24/site-admin/internal/runtime/nitro2'

export default defineNitroPlugin((nitroApp) => {
  const hooks = useServerHooks()
  /** @type {WeakMap<import('@liria24/site-admin/internal/server').SiteAdminDatabase, import('@liria24/site-admin/internal/server').SiteAdmin<import('nuxt/server').RequestEvent>>} */
  const instances = new WeakMap()
  const databases = createSiteAdminDatabaseScope(domainConfig.database, (context) => hooks.callHook('site-admin:database', context))
  /** @type {WeakMap<object, import('nuxt/server').RequestEvent>} */
  const nativeEvents = new WeakMap()
  const authorize = ${authorize}
  nitroApp.hooks.hook('request', (event) => {
    captureNitroRequest(event, ${JSON.stringify(options.server.managementBase)}, ${JSON.stringify(Boolean(domainConfig.assets))})
  })
  /** @param {import('nuxt/server').RequestEvent} [event] @returns {Promise<import('@liria24/site-admin/nuxt').SiteAdminDatabaseContext>} */
  const resolveDatabases = (event, platformContext) => {
    if (event) nativeEvents.set(event.context, event)
    return databases.resolve(event, platformContext)
  }
  /** @param {import('nuxt/server').RequestEvent} [event] @returns {Promise<import('@liria24/site-admin/internal/server').SiteAdmin<import('nuxt/server').RequestEvent>>} */
  const getSiteAdmin = async (event, platformContext) => {
    const context = await resolveDatabases(event, platformContext)
    const database = context.database
    let siteAdmin = instances.get(database)
    if (siteAdmin) return siteAdmin
    siteAdmin = createSiteAdmin({
    authorize,
    afterCommit: (event) => hooks.callHook('site-admin:entry:committed', event),
    config: { ...domainConfig, assets: ${JSON.stringify(domainConfig.assets)} },
    database,
    ${filesOption}
    ${localizePath}
    managementBase: ${JSON.stringify(options.server.managementBase)},
    publicBase: ${JSON.stringify(options.client.basePath)},
    routing: ${JSON.stringify(options.routing)},
    site: ${JSON.stringify(site)},
    })
    instances.set(database, siteAdmin)
    return siteAdmin
  }
  ${
      options.llms
          ? `nitroApp.hooks.hook('llms:generate', async (event, options) => {
    const entries = await (await getSiteAdmin(nativeEvents.get(event.context))).llmsEntries()
    if (entries.length === 0) return
    options.sections.push({
      links: entries.map(({ content: _, ...entry }) => entry),
      title: 'Site content',
    })
  })
  nitroApp.hooks.hook('llms:generate:full', async (event, _options, contents) => {
    const entries = await (await getSiteAdmin(nativeEvents.get(event.context))).llmsEntries()
    contents.push(...entries.map((entry) =>
      \`## [\${entry.title}](\${entry.href})\${entry.description ? \`\\n\\n\${entry.description}\` : ''}\${entry.content ? \`\\n\\n\${entry.content}\` : ''}\`,
    ))
  })`
          : ''
  }
  configureSiteAdminRuntime({
    ${nuxt.options.dev ? `development: ${JSON.stringify({ connector: 'application', devDatabase: false, locales })},` : ''}
    managementBase: ${JSON.stringify(options.server.managementBase)},
    publicBase: ${JSON.stringify(options.client.basePath)},
    tasks: ${JSON.stringify(domainConfig.tasks ?? {})},
    getSiteAdmin,
    initializeRequest: ${options.auth && !domainConfig.database && Object.keys(domainConfig.models).length > 0 ? 'async (event) => { nativeEvents.set(event.context, event); await databases.prepare(event) }' : '(event) => { nativeEvents.set(event.context, event) }'},
    ${
        namedAiActions
            ? `runAiAction: async (event, name, input) => executeSiteAdminAiAction(domainConfig, name, input, {
      actor: await authorize?.(event.req, event), request: event.req, platformContext: event.context,
    }),`
            : ''
    }
    authDatabase: (context) => context ? databases.get(context)?.authDatabase : undefined,
  })
})
`,
            write: true,
        })
        addServerPlugin(runtimeTemplate.dst)
        const resolver = createResolver(import.meta.url)
        if (cmsConfigured)
            addServerHandler({
                handler: resolver.resolve('./runtime/public-handler'),
                route: `${options.client.basePath}/**`,
            })
        if (options.auth) {
            if (namedAiActions)
                addServerHandler({
                    handler: resolver.resolve('./runtime/ai-action-handler'),
                    route: `${options.server.managementBase}/ai/actions/**`,
                })
            addServerHandler({
                handler: resolver.resolve('./runtime/management-handler'),
                route: `${options.server.managementBase}/**`,
            })
        }
        if (
            nuxt.options.dev &&
            options.devtools &&
            nuxt.options.devtools !== false &&
            (typeof nuxt.options.devtools !== 'object' || nuxt.options.devtools.enabled !== false)
        ) {
            const { setupSiteAdminDevtools } = await import('./devtools')
            await setupSiteAdminDevtools(nuxt)
        }
        addServerImports({ from: '@liria24/site-admin/server', name: 'useAdmin' })
        nitro.externals.inline!.push(normalize(runtimeTemplate.dst), normalize(configPath))
    },
})
