import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { directoryToURL, loadNuxtModuleInstance, resolveModuleWithOptions, tryResolveModule } from 'nuxt/kit'
import type { ModuleDependencies, Nuxt, NuxtModule } from 'nuxt/schema'

import { moduleMeta } from '../meta'

/** Keep Nitro's native TS transform active for SDK-generated app config in Nuxt's cache directory. */
export const allowGeneratedFilesConfig = (exclude: unknown, directory: string): Array<string | RegExp> => {
    const prefix = directory
        .replaceAll('\\', '/')
        .split('/')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('[\\\\/]')
    const patterns = Array.isArray(exclude) ? exclude : [exclude ?? /node_modules/u]
    return patterns.map((pattern: unknown) => {
        if (typeof pattern === 'string') return pattern
        if (pattern instanceof RegExp) {
            return new RegExp(`^(?!${prefix}[\\\\/])[\\s\\S]*(?:${pattern.source})`, pattern.flags)
        }
        throw new Error('[site-admin] Nitro TypeScript exclude filters must be strings or regular expressions.')
    })
}

interface ConfiguredModule {
    module: NuxtModule
    inline: Record<string, unknown>
    modulePath?: string
}

/** Resolve metadata and tuple options with Nuxt's own public loader, including function/path entries. */
const configuredModule = async (nuxt: Nuxt, name: string): Promise<ConfiguredModule | undefined> => {
    for (const entry of nuxt.options.modules ?? []) {
        const resolved = resolveModuleWithOptions(entry, nuxt)
        if (!resolved) continue
        const { nuxtModule, resolvedModulePath } = await loadNuxtModuleInstance(resolved.module, nuxt)
        if ((await nuxtModule.getMeta?.())?.name === name) {
            return {
                module: nuxtModule,
                inline: resolved.options,
                ...(resolvedModulePath ? { modulePath: resolvedModulePath } : {}),
            }
        }
    }
    return undefined
}

/** Use the actual configured native module owner, including a directly imported function. */
export const resolveSiteAdminFilesModulePath = async (nuxt: Nuxt): Promise<string> => {
    const configured = await configuredModule(nuxt, 'nuxt-files-sdk')
    if (configured?.modulePath) return configured.modulePath
    const roots = [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((dir) => resolve(dir, '..'))]
    const candidates = await Promise.all(
        roots.map((root) => tryResolveModule('nuxt-files-sdk', [directoryToURL(root)])),
    )
    for (const path of [
        ...new Set(
            [...candidates, fileURLToPath(import.meta.resolve('nuxt-files-sdk'))].filter(
                (candidate): candidate is string => Boolean(candidate),
            ),
        ),
    ]) {
        if (!configured || (await loadNuxtModuleInstance(path, nuxt)).nuxtModule === configured.module) return path
    }
    throw new Error('[site-admin] Cannot verify the configured native Files module owner.')
}

const topLevelFiles = (nuxt: Nuxt): { config?: unknown } | undefined =>
    (nuxt.options as typeof nuxt.options & { files?: { config?: unknown } }).files

const fallbackSource = (nuxt: Nuxt, siteAdminConfigFile: string): string =>
    existsSync(resolve(nuxt.options.rootDir, 'files.config.ts')) ? 'files.config.ts' : siteAdminConfigFile

const configFilename = (value: unknown, owner: string): string => {
    if (typeof value !== 'string' || !value.length) {
        throw new Error(`[site-admin] ${owner} configuration filename must be a non-empty string.`)
    }
    return value
}

/** Register a fallback before any module setups; optional dependencies never install Files by themselves. */
export const siteAdminFilesModuleDependencies = async (nuxt: Nuxt): Promise<ModuleDependencies> => {
    // Nuxt merges dependency defaults into config keys; preserve its explicit module opt-out.
    if ((nuxt.options as typeof nuxt.options & { files?: unknown }).files === false) return {}
    const configured = await configuredModule(nuxt, moduleMeta.name)
    const ownOptions = configured?.module.getOptions
        ? await configured.module.getOptions(configured.inline, nuxt)
        : (nuxt.options as typeof nuxt.options & { siteAdmin?: { configFile?: string } }).siteAdmin
    if (ownOptions && 'enabled' in ownOptions && ownOptions.enabled === false) return {}
    const configFile = configFilename(ownOptions?.configFile ?? './site-admin.config.ts', 'Site Admin')
    return { 'nuxt-files-sdk': { optional: true, defaults: { config: fallbackSource(nuxt, configFile) } } }
}

/** Resolve exactly one effective Files filename, preserving explicit native inline and top-level options. */
export const resolveSiteAdminFilesSource = async (nuxt: Nuxt, siteAdminConfigFile: string): Promise<string> => {
    const configured = await configuredModule(nuxt, 'nuxt-files-sdk')
    const topLevel = topLevelFiles(nuxt)
    const hasInlineConfig = configured?.inline.config !== undefined && configured.inline.config !== null
    const hasTopLevelConfig = topLevel?.config !== undefined && topLevel.config !== null
    let filename: unknown
    if (configured && (hasInlineConfig || hasTopLevelConfig)) {
        const nativeOptions = await configured.module.getOptions?.(configured.inline, nuxt)
        filename = nativeOptions?.config ?? (hasInlineConfig ? configured.inline.config : topLevel?.config)
    } else {
        filename = hasTopLevelConfig ? topLevel?.config : fallbackSource(nuxt, siteAdminConfigFile)
    }
    const path = resolve(nuxt.options.rootDir, configFilename(filename, 'Files'))
    if (!existsSync(path)) throw new Error(`[site-admin] Files configuration file does not exist: ${path}`)
    if (!statSync(path).isFile()) throw new Error(`[site-admin] Files configuration path must be a file: ${path}`)
    return path
}
