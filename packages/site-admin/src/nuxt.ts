import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'

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
} from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import type { AppSession } from '@nuxtjs/better-auth'
import type { BetterAuthOptions } from 'better-auth'
import type { H3Event } from 'h3'
import type { NitroConfig } from 'nitropack/types'
import { createJiti } from 'jiti'
import type { ModuleOptions as NuxtLLMsOptions } from 'nuxt-llms'
import type { SiteAdminDatabase } from './adapter'

import type { SiteAdminConfig } from './config'
import type { SiteAdminActor } from './server/types'
import { moduleMeta } from './meta'

export interface ModuleOptions {
    ai: false | { configFile?: string }
    auth: boolean
    assets?: SiteAdminConfig['assets']
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
    event: H3Event
    request: Request
    session: AppSession
}

export interface SiteAdminDatabaseContext {
    authDatabase?: BetterAuthOptions['database']
    database?: SiteAdminDatabase
    event?: H3Event
}

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

declare module 'nitropack/types' {
    interface NitroRuntimeHooks {
        'site-admin:database': (context: SiteAdminDatabaseContext) => void | Promise<void>
        'site-admin:authorize': (context: SiteAdminAuthorizeContext) => void | Promise<void>
    }
}

const defaults: ModuleOptions = {
    ai: false,
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

const installOnce = async (name: string, nuxt: Nuxt): Promise<void> => {
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
    await installModule(path, {}, nuxt)
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
): string => `import { admin, createAccessControl } from 'better-auth/plugins'
${accessControl(config)}
export default admin({ ac, adminRoles: ['admin'], defaultRole: 'user', roles })
`

const clientAccessPlugin = (
    config: SiteAdminConfig,
): string => `import { adminClient } from 'better-auth/client/plugins'
import { createAccessControl } from 'better-auth/plugins'
${accessControl(config)}
export default adminClient({ ac, roles })
`

const betterAuthDatabaseProvider =
    (): string => `const databaseKey = Symbol.for('@liria24/site-admin/request-databases')

export const db = undefined
export function createDatabase(event) {
  const database = event?.context?.[databaseKey]?.authDatabase
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
        options.seo || options.ogImage || options.schemaOrg
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
    async setup(input, nuxt) {
        // Nuxt merges defaults before setup; the public input type allows nested partial options.
        const options = input as ModuleOptions
        if (!options.enabled) return
        // Nuxt normally adds this after setup; our dependent modules need it during setup.
        const modulesDir = createResolver(import.meta.url).resolve('../node_modules')
        if (!nuxt.options.modulesDir.includes(modulesDir)) nuxt.options.modulesDir.push(modulesDir)
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

        const clientTemplate = addTemplate({
            filename: 'site-admin/client.ts',
            getContents: () => `import { createSiteAdminClient } from '@liria24/site-admin/client'
import type { SiteAdminClient, PublicRouteResult } from '@liria24/site-admin/client'
import { useRequestEvent, useRequestURL, useState } from '#imports'
export const useSiteAdminClient = (): SiteAdminClient => {
  const event = useRequestEvent()
  return createSiteAdminClient({ ...${JSON.stringify(options.client)}, origin: ${options.client.origin ? JSON.stringify(options.client.origin) : 'useRequestURL().origin'},
    ${
        options.client.origin
            ? ''
            : `fetch: import.meta.server && event ? (input, init) => {
      const url = new URL(String(input))
      return event.fetch(url.pathname + url.search, init)
    } : globalThis.fetch,`
    }
  })
}
export const useSiteAdminRoute = () => useState<PublicRouteResult | null>('site-admin-route', () => null)
`,
            write: true,
        })
        addImports([
            { from: clientTemplate.dst, name: 'useSiteAdminClient' },
            { from: clientTemplate.dst, name: 'useSiteAdminRoute' },
        ])
        if (options.routing.enabled) {
            const middleware = addTemplate({
                filename: 'site-admin/route-middleware.mjs',
                getContents: () => routeMiddleware(options, publicLocales),
                write: true,
            })
            addRouteMiddleware({ global: true, name: 'site-admin-public-route', path: middleware.dst })
        }
        if (options.seo || options.ogImage || options.schemaOrg) {
            const plugin = addTemplate({
                filename: 'site-admin/metadata-plugin.mjs',
                getContents: () => metadataPlugin(options),
                write: true,
            })
            addPlugin(plugin.dst)
        }

        const nitro = (nuxt.options as unknown as { nitro: NitroConfig }).nitro
        nitro.externals ??= {}
        ;(nitro.externals.inline ??= []).push('@liria24/site-admin')

        let domainConfig: SiteAdminConfig | undefined
        let configPath: string | undefined
        if (options.server.enabled) {
            configPath = resolve(nuxt.options.rootDir, options.configFile)
            const configFiles = [
                configPath,
                ...(options.ai ? [resolve(nuxt.options.rootDir, options.ai.configFile ?? './site-admin.ai.ts')] : []),
            ]
            nuxt.hook('prepare:types', ({ tsConfig }) => {
                ;(tsConfig.include ??= []).push(...configFiles)
            })
            if (nuxt.options.dev) {
                // ponytail: watch the config entrypoints; imported helpers can use Nuxt's watch option.
                nuxt.options.watch.push(...configFiles.map((path) => path.replaceAll('\\', '/')))
            }
            const jiti = createJiti(import.meta.url, { alias: nuxt.options.alias, fsCache: false, moduleCache: false })
            domainConfig = await jiti.import<SiteAdminConfig>(configPath, { default: true })
            if (options.assets) domainConfig.assets = { ...domainConfig.assets, ...options.assets }
            await nuxt.callHook('site-admin:config', domainConfig)
            if (options.auth === true) {
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
                nuxt.hook('better-auth:database:providers', (providers) => {
                    providers.siteAdmin = {
                        priority: 1_000,
                        isEnabled: () => true,
                        buildDatabaseCode: betterAuthDatabaseProvider,
                    }
                })
                await installOnce('@nuxtjs/better-auth', nuxt)
            }
            if (domainConfig.assets) {
                await installOnce('nuxt-files-sdk', nuxt)
                nitro.rollupConfig ??= {}
                const existing = nitro.rollupConfig.plugins
                nitro.rollupConfig.plugins = [
                    existing,
                    {
                        name: 'site-admin-cloudflare-upload-stream',
                        transform(code, id) {
                            // Nitro 2 buffers before H3 runs. Remove when its Cloudflare bridge streams natively.
                            if (!id.replaceAll('\\', '/').endsWith('/cloudflare/runtime/_module-handler.mjs')) return
                            const buffered = 'body = Buffer.from(await request.arrayBuffer());'
                            return {
                                // Preserve line and column offsets in Nitro's source map.
                                code: code.replace(buffered, 'body = request.body;'.padEnd(buffered.length)),
                                map: null,
                            }
                        },
                    },
                ]
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
            ? `async (request, event) => {
      if (!event) return null
      const session = await getRequestSession(event)
      if (!session) return null
      const role = session.user.role
      const roles = typeof role === 'string' ? role.split(',').map((value) => value.trim()).filter(Boolean) : []
      const context = { actor: { id: session.user.id, roles }, event, request, session }
      await nitroApp.hooks.callHook('site-admin:authorize', context)
      return context.actor
    }`
            : 'undefined'
        const filesImport = domainConfig.assets ? `import { useServerFiles } from 'nuxt-files-sdk/runtime'` : ''
        const filesOption = domainConfig.assets ? `getFiles: async (name) => useServerFiles(name),` : ''
        const aiPath = options.ai
            ? resolve(nuxt.options.rootDir, options.ai.configFile ?? './site-admin.ai.ts').replaceAll('\\', '/')
            : undefined
        const aiImport = aiPath ? `import aiActions from ${JSON.stringify(aiPath)}` : ''
        const aiOption = aiPath ? 'aiActions,' : ''
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
        const runtimeTemplate = addTemplate({
            filename: 'site-admin/runtime.mjs',
            getContents: () => `import { defineNitroPlugin } from 'nitropack/runtime'
${authImport}
${filesImport}
${aiImport}
import domainConfig from ${JSON.stringify(configPath.replaceAll('\\', '/'))}
import { configureSiteAdminRuntime, createSiteAdmin } from '@liria24/site-admin/server'

export default defineNitroPlugin((nitroApp) => {
  const instances = new WeakMap()
  const databaseKey = Symbol.for('@liria24/site-admin/request-databases')
  const resolveDatabases = async (event) => {
    const cached = event?.context?.[databaseKey]
    if (cached) return cached
    const context = { event, database: undefined, authDatabase: undefined }
    await nitroApp.hooks.callHook('site-admin:database', context)
    if (!context.database) throw new Error('[site-admin] The site-admin:database hook must provide a database adapter.')
    ${options.auth ? `if (event && !context.authDatabase) throw new Error('[site-admin] The site-admin:database hook must provide authDatabase when authentication is enabled.')` : ''}
    if (event?.context) event.context[databaseKey] = context
    return context
  }
  ${options.auth ? `nitroApp.hooks.hook('request', resolveDatabases)` : ''}
  const getSiteAdmin = async (event) => {
    const context = await resolveDatabases(event)
    const database = context.database
    let siteAdmin = instances.get(database)
    if (siteAdmin) return siteAdmin
    siteAdmin = createSiteAdmin({
    ${aiOption}
    aiEnabled: ${JSON.stringify(options.ai !== false)},
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
    const entries = await (await getSiteAdmin(event)).llmsEntries()
    if (entries.length === 0) return
    options.sections.push({
      links: entries.map(({ content: _, ...entry }) => entry),
      title: 'Site content',
    })
  })
  nitroApp.hooks.hook('llms:generate:full', async (event, _options, contents) => {
    const entries = await (await getSiteAdmin(event)).llmsEntries()
    contents.push(...entries.map((entry) =>
      \`## [\${entry.title}](\${entry.href})\${entry.description ? \`\\n\\n\${entry.description}\` : ''}\${entry.content ? \`\\n\\n\${entry.content}\` : ''}\`,
    ))
  })`
          : ''
  }
  // Nitro does not await plugins. Database bindings become available during requests/events;
  // Core operations initialize lazily and share the same initialization promise.
  configureSiteAdminRuntime({
    ${nuxt.options.dev ? `development: ${JSON.stringify({ connector: 'application', devDatabase: false, locales })},` : ''}
    managementBase: ${JSON.stringify(options.server.managementBase)},
    publicBase: ${JSON.stringify(options.client.basePath)},
    getSiteAdmin,
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
        addServerImports({ from: '@liria24/site-admin/server', name: 'useSiteAdmin' })
        nitro.externals.inline!.push(
            runtimeTemplate.dst.replaceAll('\\', '/'),
            configPath.replaceAll('\\', '/'),
            ...(aiPath ? [aiPath] : []),
        )
    },
})
