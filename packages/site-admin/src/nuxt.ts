import { resolve } from 'node:path'

import {
    addServerHandler,
    addServerImports,
    addServerPlugin,
    addTemplate,
    createResolver,
    defineNuxtModule,
    hasNuxtModule,
    installModule,
} from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { createJiti } from 'jiti'

import type { SiteAdminConfig } from './config'
import type { SiteAdminActor } from './server/types'

export type DatabaseConfig =
    | { bindingName: string; connector: 'cloudflare-d1' }
    | { connector: 'node-sqlite'; path?: string }

export interface ModuleOptions {
    ai: { enabled: boolean }
    auth: { enabled: boolean }
    client: { basePath: string; origin?: string }
    configFile: string
    database: DatabaseConfig
    devDatabase?: DatabaseConfig
    enabled: boolean
    i18n: boolean | 'auto'
    llms: { enabled: boolean; full: boolean }
    ogImage: boolean
    robots: boolean
    routing: { enabled: boolean; preserveHistory: boolean; redirects: boolean }
    schemaOrg: boolean
    seo: boolean
    server: { enabled: boolean; publicBase: string; writeBase: string }
    sitemap: boolean
}

export interface SiteAdminAuthorizeContext {
    actor: SiteAdminActor | null
    request: Request
}

declare module '@nuxt/schema' {
    interface NuxtConfig {
        siteAdmin?: Partial<ModuleOptions>
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
        'site-admin:authorize': (context: SiteAdminAuthorizeContext) => void | Promise<void>
    }
}

const defaults: ModuleOptions = {
    ai: { enabled: false },
    auth: { enabled: true },
    client: { basePath: '/api/content' },
    configFile: './site-admin.config.ts',
    database: { connector: 'node-sqlite', path: '.data/site-admin.sqlite3' },
    enabled: true,
    i18n: 'auto',
    llms: { enabled: true, full: true },
    ogImage: true,
    robots: true,
    routing: { enabled: true, preserveHistory: true, redirects: true },
    schemaOrg: true,
    seo: true,
    server: { enabled: true, publicBase: '/api/content', writeBase: '/api/site-admin' },
    sitemap: true,
}

const normalizeBase = (value: string, name: string): string => {
    const normalized = `/${value.split('/').filter(Boolean).join('/')}`
    if (normalized === '/' || normalized.includes('?') || normalized.includes('#')) {
        throw new Error(`[site-admin] ${name} must be a non-root URL path.`)
    }
    return normalized
}

const databaseSource = (
    database: DatabaseConfig,
    rootDir: string,
): { importName: string; options: string } => {
    if (database.connector === 'cloudflare-d1') {
        if (!database.bindingName)
            throw new Error('[site-admin] database.bindingName is required for Cloudflare D1.')
        return {
            importName: 'db0/connectors/cloudflare-d1',
            options: JSON.stringify({ bindingName: database.bindingName }),
        }
    }
    return {
        importName: 'db0/connectors/node-sqlite',
        options: JSON.stringify({ cwd: rootDir, path: database.path ?? '.data/site-admin.sqlite3' }),
    }
}

const installOnce = async (name: string, nuxt: Nuxt): Promise<void> => {
    if (!hasNuxtModule(name, nuxt)) await installModule((await import(name)).default, {}, nuxt)
}

export default defineNuxtModule<ModuleOptions>({
    meta: {
        compatibility: { nuxt: '^4.0.0' },
        configKey: 'siteAdmin',
        name: '@liria24/site-admin',
    },
    defaults,
    async setup(options, nuxt) {
        if (!options.enabled) return
        options.server.publicBase = normalizeBase(options.server.publicBase, 'server.publicBase')
        options.server.writeBase = normalizeBase(options.server.writeBase, 'server.writeBase')
        if (options.server.publicBase === options.server.writeBase) {
            throw new Error('[site-admin] Public and management API paths must differ.')
        }
        const configPath = resolve(nuxt.options.rootDir, options.configFile)
        const jiti = createJiti(import.meta.url, { fsCache: false })
        const domainConfig = await jiti.import<SiteAdminConfig>(configPath, { default: true })
        await nuxt.callHook('site-admin:config', domainConfig)

        if (!options.server.enabled) return
        if (domainConfig.assets) await installOnce('nuxt-files-sdk', nuxt)
        if (options.seo) await installOnce('nuxt-seo-utils', nuxt)
        if (options.sitemap) {
            const sitemapOptions = (
                nuxt.options as typeof nuxt.options & {
                    sitemap?: { sources?: Array<string> }
                }
            ).sitemap
            const source = `${options.server.publicBase}/_sitemap`
            if (sitemapOptions) {
                sitemapOptions.sources ??= []
                if (!sitemapOptions.sources.includes(source)) sitemapOptions.sources.push(source)
            } else {
                ;(nuxt.options as typeof nuxt.options & { sitemap: { sources: string[] } }).sitemap = {
                    sources: [source],
                }
            }
            await installOnce('@nuxtjs/sitemap', nuxt)
        }
        if (options.robots) await installOnce('@nuxtjs/robots', nuxt)
        if (options.ogImage) await installOnce('nuxt-og-image', nuxt)
        if (options.schemaOrg) await installOnce('nuxt-schema-org', nuxt)

        const selectedDatabase =
            nuxt.options.dev && options.devDatabase ? options.devDatabase : options.database
        const database = databaseSource(selectedDatabase, nuxt.options.rootDir)
        const nuxtSite = (nuxt.options as typeof nuxt.options & { site?: { name?: string; url?: string } })
            .site
        const site = {
            ...(typeof nuxtSite?.name === 'string' ? { name: nuxtSite.name } : {}),
            ...(typeof nuxtSite?.url === 'string' ? { url: nuxtSite.url } : {}),
        }
        const assetStorage = domainConfig.assets?.storage
        const filesImport = assetStorage ? `import { useServerFiles } from 'nuxt-files-sdk/runtime'` : ''
        const filesOption = assetStorage
            ? `getFiles: async (name) => {
      if (name !== ${JSON.stringify(assetStorage)}) throw new Error('[site-admin] Unknown Asset storage "' + name + '".')
      return useServerFiles(${JSON.stringify(assetStorage)})
    },`
            : ''
        const runtimeTemplate = addTemplate({
            filename: 'site-admin/runtime.mjs',
            getContents: () => `import { defineNitroPlugin } from 'nitropack/runtime'
import { createDatabase } from 'db0'
import connector from ${JSON.stringify(database.importName)}
${filesImport}
import domainConfig from ${JSON.stringify(configPath.replaceAll('\\', '/'))}
import { configureSiteAdminRuntime, createSiteAdmin } from '@liria24/site-admin/server'

export default defineNitroPlugin(async (nitroApp) => {
  const database = createDatabase(connector(${database.options}))
  const siteAdmin = createSiteAdmin({
    aiEnabled: ${JSON.stringify(options.ai.enabled)},
    authorize: async (request) => {
      const context = { actor: null, request }
      await nitroApp.hooks.callHook('site-admin:authorize', context)
      return context.actor
    },
    config: domainConfig,
    database,
    ${filesOption}
    managementBase: ${JSON.stringify(options.server.writeBase)},
    publicBase: ${JSON.stringify(options.server.publicBase)},
    routing: ${JSON.stringify(options.routing)},
    site: ${JSON.stringify(site)},
  })
  await siteAdmin.initialize()
  configureSiteAdminRuntime({
    managementBase: ${JSON.stringify(options.server.writeBase)},
    publicBase: ${JSON.stringify(options.server.publicBase)},
    siteAdmin,
  })
  nitroApp.hooks.hook('close', () => database.dispose())
})
`,
            write: true,
        })
        addServerPlugin(runtimeTemplate.dst)
        const resolver = createResolver(import.meta.url)
        addServerHandler({
            handler: resolver.resolve('./runtime/public-handler'),
            route: `${options.server.publicBase}/**`,
        })
        if (options.auth.enabled) {
            addServerHandler({
                handler: resolver.resolve('./runtime/management-handler'),
                route: `${options.server.writeBase}/**`,
            })
        }
        if (options.llms.enabled) {
            addServerHandler({ handler: resolver.resolve('./runtime/llms-handler'), route: '/llms.txt' })
            if (options.llms.full) {
                addServerHandler({
                    handler: resolver.resolve('./runtime/llms-handler'),
                    route: '/llms-full.txt',
                })
            }
        }
        const devtoolsEnabled =
            nuxt.options.devtools === true ||
            (typeof nuxt.options.devtools === 'object' && nuxt.options.devtools.enabled)
        if (nuxt.options.dev && devtoolsEnabled) {
            addServerHandler({
                handler: resolver.resolve('./runtime/diagnostics-handler'),
                route: '/_site-admin/diagnostics',
            })
        }
        addServerImports({ from: '@liria24/site-admin/server', name: 'useSiteAdmin' })
        const nitro = (
            nuxt.options as typeof nuxt.options & {
                nitro: { externals?: { inline?: Array<RegExp | string> } }
            }
        ).nitro
        nitro.externals ??= {}
        ;(nitro.externals.inline ??= []).push('@liria24/site-admin', configPath.replaceAll('\\', '/'))
    },
})
