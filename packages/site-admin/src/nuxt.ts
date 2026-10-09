import { dirname, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'
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
    addVitePlugin,
    createResolver,
    defineNuxtModule,
    hasNuxtModule,
    installModule,
    tryResolveModule,
    directoryToURL,
} from 'nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import type { AppSession } from '@nuxtjs/better-auth'
import type { BetterAuthOptions } from 'better-auth'
import type { RequestEvent } from 'nuxt/server'
import { transformNitroCloudflareRequest } from './runtime/nitro2'
import { stopNitroDevReloadOnClose } from './nuxt/dev-close'
import {
    siteAdminFilesModuleDependencies,
    resolveSiteAdminFilesSource,
    resolveSiteAdminFilesModulePath,
    allowGeneratedFilesConfig,
} from './nuxt/files-source'
import type { Nitro, NitroConfig } from 'nitropack/types'
import { createJiti } from 'jiti'
import type { ModuleOptions as NuxtLLMsOptions } from 'nuxt-llms'
import type { SiteAdminDatabase } from './adapter'

import type { SiteAdminConfig, SiteAdminConfigInput } from './config'
import { resolveSiteAdminConfig } from './config-resolution'
import { serializeSiteAdminSeo, serializeSiteAdminRouteRules } from './seo'
import { resolveSiteAdminAssets } from './assets-config'
import {
    assertSiteAdminDependencyAliasConflicts,
    createSiteAdminDependencyAliases,
    createSiteAdminDependencyPlugin,
    createSiteAdminDependencyTypePaths,
    removeSiteAdminDependencyAliases,
} from './dependency-aliases'
import { nativeFilesConfigAliases } from './nuxt/files-aliases'
import {
    siteAdminNuxtClientTemplate,
    siteAdminNuxtFormTemplate,
    siteAdminNuxtModelTypes,
    siteAdminNuxtSeoTemplate,
} from './nuxt/client-templates'
import type { SiteAdminActor } from './server/types'
import { moduleMeta } from './meta'

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
    routing: { enabled: boolean; metadata: boolean; preserveHistory: boolean; redirects: boolean }
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

export interface SiteAdminDatabaseContext {
    request?: Request
    authDatabase?: BetterAuthOptions['database']
    database?: SiteAdminDatabase
    event?: RequestEvent
    /** Native task context, including Cloudflare bindings, for event-free work. */
    platformContext?: object
}

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
    routing: { enabled: true, metadata: true, preserveHistory: true, redirects: true },
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

const installOnce = async (name: string, nuxt: Nuxt, options: Record<string, unknown> = {}): Promise<void> => {
    if (hasNuxtModule(name, nuxt)) return
    const candidate = await tryResolveModule(
        name,
        [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((dir) => resolve(dir, '..'))].map(directoryToURL),
    )
    const path = candidate ?? fileURLToPath(import.meta.resolve(name))
    // Nested npm dependencies must be visible before the module installs its own modules.
    const manifest = findPackageJSON(pathToFileURL(path))
    if (manifest) {
        const modulesDir = resolve(dirname(manifest), 'node_modules')
        if (!nuxt.options.modulesDir.includes(modulesDir)) nuxt.options.modulesDir.push(modulesDir)
    }
    await installModule(path, options, nuxt)
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

const accessControl = (config: SiteAdminConfig): string => {
    const modelActions = [
        'ai',
        'create',
        'delete',
        'publish',
        'prune',
        'readDraft',
        'restore',
        'schedule',
        'sort',
        'update',
    ]
    const assetActions = ['delete', 'gc', 'read', 'upload']
    const systemActions = ['diagnostics', 'publishDue']
    const resources = {
        ...Object.fromEntries(Object.keys(config.models).map((name) => [`siteAdmin:model:${name}`, modelActions])),
        'siteAdmin:assets': assetActions,
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
    return `const resources = ${JSON.stringify(resources)}
const ac = createAccessControl(resources)
const roles = {
  admin: ac.newRole(resources),
  user: ac.newRole(Object.fromEntries(Object.keys(resources).map((name) => [name, []]))),
  ...Object.fromEntries(Object.entries(${JSON.stringify(custom)}).map(([name, permissions]) => [name, ac.newRole(permissions)])),
}`
}

const serverAccessPlugin = (
    config: SiteAdminConfig,
): string => `import { admin, createAccessControl } from '#better-auth/plugins'
${accessControl(config)}
export default admin({ ac, adminRoles: ['admin'], defaultRole: 'user', roles })
`

const clientAccessPlugin = (
    config: SiteAdminConfig,
): string => `import { adminClient } from '#better-auth/client/plugins'
import { createAccessControl } from '#better-auth/plugins'
${accessControl(config)}
export default adminClient({ ac, roles })
`

const betterAuthDatabaseProvider = (): string => `import { useSiteAdminRuntime } from '@liria24/site-admin/nuxt/server'

export const db = undefined
export function createDatabase(event) {
  const database = useSiteAdminRuntime().authDatabase?.(event?.context)
  if (!database) throw new Error('[site-admin] The site-admin:database hook must provide authDatabase when authentication is enabled.')
  return database
}
`

const routeMiddleware = (options: ModuleOptions, locales: ReturnType<typeof localeOptions>): string => {
    const imports = ['defineNuxtRouteMiddleware', 'navigateTo', 'useState']
    if (options.i18n) imports.push('useNuxtApp')
    const i18nLocale = options.i18n
        ? `const i18n = useNuxtApp().$i18n
  const currentLocale = typeof i18n?.locale === 'string' ? i18n.locale : i18n?.locale?.value
  const pathLocale = to.path.split('/').filter(Boolean)[0]
  const localeCodes = ${JSON.stringify(locales.supported)}
  const locale = ${JSON.stringify(locales.strategy)} === 'no_prefix'
    ? currentLocale
    : localeCodes.includes(pathLocale)
      ? pathLocale
      : ${JSON.stringify(locales.strategy)} === 'prefix_except_default'
        ? ${JSON.stringify(locales.defaultLocale)}
        : currentLocale
  if (locale && locale !== currentLocale && typeof i18n?.locale === 'object') i18n.locale.value = locale`
        : 'const locale = undefined'
    const metadata =
        options.routing.metadata && (options.seo || options.ogImage || options.schemaOrg)
            ? `const entry = result.entry
  const models = await client.models()
  const displayFields = models.models[entry.model]?.displayFields
  const title = String(entry.data?.[displayFields?.title || 'title'] ?? entry.data?.name ?? '')
  const description = String(entry.data?.[displayFields?.description || 'description'] ?? '')
  const image = entry.data?.[displayFields?.image || 'image']
  result.meta = { description, imageId: typeof image === 'string' ? image : image?.id, title }`
            : ''
    return `import { ${imports.join(', ')} } from '#imports'
import { useSiteAdminClient } from '#build/site-admin/client'

export default defineNuxtRouteMiddleware(async (to) => {
  const client = useSiteAdminClient()
  const state = useState('site-admin-route', () => null)
  state.value = null
  ${i18nLocale}
  const result = await client.resolveRoute(to.path, { locale })
  if (!result) return
  if (result.kind === 'redirect') return navigateTo(result.target, { external: result.target.startsWith('http://') || result.target.startsWith('https://'), redirectCode: result.status })
  ${metadata}
  state.value = result
})
`
}

const metadataPlugin = (options: ModuleOptions): string => {
    const imports = ['computed', 'defineNuxtPlugin', 'useRequestURL', 'useState']
    if (options.seo) imports.push('useHead', 'useSeoMeta')
    if (options.ogImage) imports.push('useSeoMeta')
    if (options.schemaOrg) imports.push('useSchemaOrg')
    return `import { ${[...new Set(imports)].join(', ')} } from '#imports'
import { useSiteAdminClient } from '#build/site-admin/client'

export default defineNuxtPlugin(() => {
  const route = useState('site-admin-route', () => null)
  const meta = computed(() => route.value?.meta)
  const origin = ${JSON.stringify(options.client.origin ?? '')} || useRequestURL().origin
  ${
      options.seo
          ? `useSeoMeta({
    title: () => meta.value?.title,
    description: () => meta.value?.description,
  })
  useHead(() => ({
    htmlAttrs: route.value?.entry?.locale ? { lang: route.value.entry.locale } : {},
    link: route.value?.kind === 'page' ? [
      ...(route.value.entry?.path ? [{ rel: 'canonical', href: new URL(route.value.entry.path, origin).href }] : []),
      ...(route.value.entry?.alternates || []).map((alternate) => ({ rel: 'alternate', hreflang: alternate.locale, href: new URL(alternate.path, origin).href })),
    ] : [],
    titleTemplate: (title) => meta.value?.title || title,
  }))`
          : ''
  }
  ${
      options.ogImage
          ? `const client = useSiteAdminClient()
  useSeoMeta({
    ogTitle: () => meta.value?.title,
    ogDescription: () => meta.value?.description,
    ogImage: () => meta.value?.imageId ? client.assetUrl(meta.value.imageId) : undefined,
  })`
          : ''
  }
  ${
      options.schemaOrg
          ? `useSchemaOrg(computed(() => meta.value ? [{ '@type': 'WebPage', name: meta.value.title, description: meta.value.description }] : []))`
          : ''
  }
})
`
}

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
        // Nuxt normally adds this after setup; our dependent modules need it during setup.
        const modulesDir = createResolver(import.meta.url).resolve('../node_modules')
        if (!nuxt.options.modulesDir.includes(modulesDir)) nuxt.options.modulesDir.push(modulesDir)
        // Configuration loaders need exact Node exports; runtime bundlers select their own conditions.
        for (const config of [
            nuxt.options.typescript.tsConfig,
            nuxt.options.typescript.appTsConfig,
            nuxt.options.typescript.nodeTsConfig,
            nuxt.options.typescript.sharedTsConfig,
            nuxt.options.typescript.serverTsConfig,
            nuxt.options.nitro.typescript?.tsConfig,
        ]) {
            assertSiteAdminDependencyAliasConflicts(config?.compilerOptions?.paths)
        }
        const filesModulePath = await resolveSiteAdminFilesModulePath(nuxt)
        const dependencyAliases = createSiteAdminDependencyAliases({
            filesModulePath,
            aliases: nuxt.options.alias,
            rootDir: nuxt.options.rootDir,
        })
        const filesConfigAliases = nativeFilesConfigAliases(filesModulePath)
        const nativeFiles = () =>
            hasNuxtModule('nuxt-files-sdk', nuxt) &&
            Object.keys(filesConfigAliases).some((name) => !(name in dependencyAliases) && name in nuxt.options.alias)
                ? {
                      modulePath: filesModulePath,
                      buildDir: nuxt.options.buildDir,
                      dev: nuxt.options.dev,
                      runtime: Boolean(
                          nuxt.options.alias['#nuxt-files-sdk/registry'] ||
                          nuxt.options.alias['nuxt-files-sdk/runtime'],
                      ),
                  }
                : undefined
        Object.assign(nuxt.options.alias, dependencyAliases)
        const dependencyTypePaths = (conditions: string[] = ['node', 'import']) => {
            const paths = createSiteAdminDependencyTypePaths({
                conditions,
                filesModulePath,
                ...(nativeFiles() && nuxt.options.alias['#nuxt-files-sdk/registry']
                    ? { nativeFiles: nativeFiles()! }
                    : {}),
            })
            if (nuxt.options.alias['#auth/client'] || nuxt.options.alias['#auth/server']) {
                // This exact public export is also referenced by the native SDK's declarations.
                paths['@nuxtjs/better-auth/config'] = paths['#nuxtjs/better-auth/config']!
            }
            return paths
        }
        addVitePlugin(createSiteAdminDependencyPlugin({ nativeFiles }))
        nuxt.hook('vite:extendConfig', (config) => {
            if (config.resolve?.alias) {
                config.resolve.alias = removeSiteAdminDependencyAliases(
                    config.resolve.alias,
                    dependencyAliases,
                    nativeFiles(),
                )
            }
        })
        // Nitro invokes this before creating its alias plugin, for production and dev/watch alike.
        nuxt.hook('nitro:build:before', (instance) => {
            instance.options.alias = removeSiteAdminDependencyAliases(
                instance.options.alias,
                dependencyAliases,
                nativeFiles(),
            )
        })
        nuxt.hook('nitro:init', (nativeInstance) => {
            const instance = nativeInstance as unknown as Nitro
            instance.hooks.hook('types:extend', ({ tsConfig }) => {
                if (!tsConfig) return
                const directory = dirname(resolve(instance.options.buildDir, instance.options.typescript.tsconfigPath))
                tsConfig.compilerOptions ??= {}
                const paths = (tsConfig.compilerOptions.paths ??= {})
                for (const [name, declarations] of Object.entries(
                    dependencyTypePaths(instance.options.exportConditions),
                )) {
                    // Nitro normalizes absolute aliases before this hook and drops .mjs/.mts
                    // extensions. Explicit relative declarations preserve .d.mts/.d.cts types.
                    paths[name] = declarations.map((path) => {
                        const target = relative(directory, path).replaceAll('\\', '/')
                        return target.startsWith('.') ? target : `./${target}`
                    })
                }
            })
        })
        nuxt.hook('prepare:types', ({ tsConfig, nodeTsConfig, sharedTsConfig, serverTsConfig }) => {
            const nodePaths = dependencyTypePaths()
            const appPaths = dependencyTypePaths(['browser', 'import'])
            for (const [config, paths] of [
                [tsConfig, appPaths],
                [nodeTsConfig, nodePaths],
                [sharedTsConfig, appPaths],
                [serverTsConfig, nodePaths],
            ] as const) {
                config.compilerOptions ??= {}
                Object.assign((config.compilerOptions.paths ??= {}), paths)
            }
        })
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

        if (options.routing.enabled) {
            const middleware = addTemplate({
                filename: 'site-admin/route-middleware.mjs',
                getContents: () => routeMiddleware(options, publicLocales),
                write: true,
            })
            addRouteMiddleware({ global: true, name: 'site-admin-public-route', path: middleware.dst })
        }
        if (options.routing.metadata && (options.seo || options.ogImage || options.schemaOrg)) {
            const plugin = addTemplate({
                filename: 'site-admin/metadata-plugin.mjs',
                getContents: () => metadataPlugin(options),
                write: true,
            })
            addPlugin(plugin.dst)
        }

        const nitro = (nuxt.options as unknown as { nitro: NitroConfig }).nitro
        nitro.externals ??= {}
        // Nuxt 4.6's renderer subpaths must be bundled so Nitro replaces their build stubs.
        ;(nitro.externals.inline ??= []).push('@liria24/site-admin', 'nuxt/internal')
        nitro.rollupConfig ??= {}
        nitro.rollupConfig.plugins = [nitro.rollupConfig.plugins, createSiteAdminDependencyPlugin({ nativeFiles })]

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
                alias: { ...nuxt.options.alias, ...filesConfigAliases },
                fsCache: false,
                moduleCache: false,
            })
            const inputConfig = await jiti.import<SiteAdminConfigInput>(configPath, { default: true })
            domainConfig = resolveSiteAdminConfig(inputConfig, environments)
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
                const serverAuthPlugin = addTemplate({
                    filename: 'site-admin/better-auth-server-plugin.mjs',
                    getContents: () => serverAccessPlugin(domainConfig!),
                    write: true,
                })
                const clientAuthPlugin = addTemplate({
                    filename: 'site-admin/better-auth-client-plugin.mjs',
                    getContents: () => clientAccessPlugin(domainConfig!),
                    write: true,
                })
                nuxt.hook('better-auth:plugins:extend', (sources) => {
                    sources.server = [...(sources.server ?? []), serverAuthPlugin.dst]
                    sources.client = [...(sources.client ?? []), clientAuthPlugin.dst]
                })
                // Preserve the existing custom-hook bridge only for legacy hook-only apps.
                // Direct adapter configurations leave Better Auth's app-owned provider intact.
                if (!domainConfig.database) {
                    nuxt.hook('better-auth:database:providers', (providers) => {
                        providers.siteAdmin = {
                            priority: 1_000,
                            isEnabled: () => true,
                            buildDatabaseCode: betterAuthDatabaseProvider,
                        }
                    })
                }
                await installOnce('@nuxtjs/better-auth', nuxt)
            }
            if (options.server.enabled && (domainConfig.assets || domainConfig.storage)) {
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
            { from: clientTemplate.dst, name: 'useSiteAdminClient' },
            { from: clientTemplate.dst, name: 'useSiteAdminManagementClient' },
            { from: clientTemplate.dst, name: 'useSiteAdminManagementEntry' },
            { from: clientTemplate.dst, name: 'useSiteAdminManagementList' },
            { from: clientTemplate.dst, name: 'useSiteAdminRoute' },
            { from: clientTemplate.dst, name: 'useSiteAdminEntry' },
            { from: clientTemplate.dst, name: 'useSiteAdminList' },
            { from: clientTemplate.dst, name: 'useSiteAdminBatch' },
        ])
        if (options.seo) {
            const seoTemplate = addTemplate({
                filename: 'site-admin/seo.ts',
                getContents: () => siteAdminNuxtSeoTemplate({ ogImage: options.ogImage }),
                write: true,
            })
            addImports({ from: seoTemplate.dst, name: 'useSeo' })
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
                addImports({ from: formTemplate.dst, name: 'useSiteAdminForm' })
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
        const aiEnabled = options.ai ?? Boolean(domainConfig.ai)
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
import { resolveSiteAdminDatabase } from '@liria24/site-admin/runtime/database'
import inputConfig from ${JSON.stringify(normalize(configPath))}
import { resolveSiteAdminConfig } from '@liria24/site-admin/config-resolution'
const domainConfig = resolveSiteAdminConfig(inputConfig, ${JSON.stringify(environments)})
delete domainConfig.storage
delete domainConfig.routes
import { createSiteAdmin } from '@liria24/site-admin/server'
import { configureSiteAdminRuntime, normalizeSiteAdminAuthorizationError } from '@liria24/site-admin/nuxt/server'
import { captureNitroRequest, getNitroRequest } from '@liria24/site-admin/runtime/nitro2'

export default defineNitroPlugin((nitroApp) => {
  const hooks = useServerHooks()
  /** @type {WeakMap<import('@liria24/site-admin/server').SiteAdminDatabase, import('@liria24/site-admin/server').SiteAdmin<import('nuxt/server').RequestEvent>>} */
  const instances = new WeakMap()
  /** @type {WeakMap<object, Promise<import('@liria24/site-admin/nuxt').SiteAdminDatabaseContext>>} */
  const pending = new WeakMap()
  /** @type {WeakMap<object, import('@liria24/site-admin/nuxt').SiteAdminDatabaseContext>} */
  const databases = new WeakMap()
  /** @type {WeakMap<object, import('nuxt/server').RequestEvent>} */
  const nativeEvents = new WeakMap()
  nitroApp.hooks.hook('request', (event) => {
    captureNitroRequest(event, ${JSON.stringify(options.server.managementBase)}, ${JSON.stringify(Boolean(domainConfig.assets))})
  })
  /** @param {import('nuxt/server').RequestEvent} [event] @returns {Promise<import('@liria24/site-admin/nuxt').SiteAdminDatabaseContext>} */
  const resolveDatabases = async (event, platformContext) => {
    if (event) {
      nativeEvents.set(event.context, event)
      const cached = pending.get(event.context)
      if (cached) return cached
    }
    const resolve = async () => {
      /** @type {import('@liria24/site-admin/nuxt').SiteAdminDatabaseContext} */
      const context = { ...(event ? { event, request: event.req } : {}), ...(platformContext ? { platformContext } : {}) }
      await hooks.callHook('site-admin:database', context)
      context.database = await resolveSiteAdminDatabase(context.database ?? domainConfig.database, {
        ...(event ? { event, request: event.req, platformContext: event.context } : {}),
        ...(platformContext ? { platformContext } : {}),
      })
      if (event) databases.set(event.context, context)
      return context
    }
    const result = resolve()
    if (event) {
      pending.set(event.context, result)
      result.catch(() => { pending.delete(event.context); databases.delete(event.context) })
    }
    return result
  }
  /** @param {import('nuxt/server').RequestEvent} [event] @returns {Promise<import('@liria24/site-admin/server').SiteAdmin<import('nuxt/server').RequestEvent>>} */
  const getSiteAdmin = async (event, platformContext) => {
    const context = await resolveDatabases(event, platformContext)
    const database = context.database
    let siteAdmin = instances.get(database)
    if (siteAdmin) return siteAdmin
    siteAdmin = createSiteAdmin({
    aiEnabled: ${JSON.stringify(aiEnabled)},
    authorize: ${authorize},
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
    initializeRequest: async (event) => { await resolveDatabases(event) },
    authDatabase: (context) => context ? databases.get(context)?.authDatabase : undefined,
  })
})
`,
            write: true,
        })
        addServerPlugin(runtimeTemplate.dst)
        const resolver = createResolver(import.meta.url)
        addServerHandler({
            handler: resolver.resolve('./runtime/public-handler'),
            route: `${options.client.basePath}/**`,
        })
        if (options.auth) {
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
        addServerImports({ from: '@liria24/site-admin/nuxt/server', name: 'useSiteAdmin' })
        nitro.externals.inline!.push(normalize(runtimeTemplate.dst), normalize(configPath))
    },
})
