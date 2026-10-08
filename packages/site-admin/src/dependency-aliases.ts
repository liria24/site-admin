import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModulePath } from 'exsolve'

/** Deliberate consumer-facing namespaces, backed by Site Admin's own dependencies. */
export const siteAdminDependencyModules = {
    '#better-auth': 'better-auth',
    '#nuxtjs/better-auth': '@nuxtjs/better-auth',
    '#nuxt-files-sdk': 'nuxt-files-sdk',
    '#files-sdk': 'files-sdk',
    '#drizzle-orm': 'drizzle-orm',
    '#comark': 'comark',
    '#comark-content': 'comark-content',
    '#ai': 'ai',
} as const

// These installed modules own exact private IDs inside otherwise public namespaces.
const privateModuleIds = new Set([
    '#better-auth/nitro-compat',
    '#better-auth/app-secret',
    '#nuxt-files-sdk/snapshot',
    '#nuxt-files-sdk/files',
])
const owner = fileURLToPath(import.meta.url)
type AliasEntries = Record<string, unknown> | ReadonlyArray<{ find: string | RegExp; replacement: string }>
let exportedDependencyIds: string[] | undefined

const dependencySpecifier = (id: string): string | undefined => {
    if (privateModuleIds.has(id)) return
    for (const [alias, name] of Object.entries(siteAdminDependencyModules)) {
        if (id === alias || id.startsWith(`${alias}/`)) return name + id.slice(alias.length)
    }
}

/** Refuse namespace collisions rather than silently replacing application/module configuration. */
export const assertSiteAdminDependencyAliasConflicts = (aliases: AliasEntries = {}): void => {
    const keys = Array.isArray(aliases) ? aliases.map((entry) => entry.find) : Object.keys(aliases)
    for (const key of keys) {
        if (typeof key === 'string' && privateModuleIds.has(key)) continue
        for (const [namespace, name] of Object.entries(siteAdminDependencyModules)) {
            const roots = [namespace, name]
            const collision =
                typeof key === 'string'
                    ? roots.some((root) => key === root || key.startsWith(`${root}/`) || root.startsWith(`${key}/`))
                    : [
                          namespace,
                          name,
                          `${namespace}/__site_admin_export__`,
                          `${name}/__site_admin_export__`,
                          ...(exportedDependencyIds ??= Object.keys(ownedExportPaths(['types', 'node', 'import'])))
                              .filter((id) => id.startsWith(`${namespace}/`))
                              .flatMap((id) => [id, name + id.slice(namespace.length)]),
                      ].some((id) => {
                          key.lastIndex = 0
                          return key.test(id)
                      })
            if (collision) {
                throw new Error(`[site-admin] Dependency namespace ${namespace} conflicts with existing alias ${key}.`)
            }
        }
    }
}

/** Remove only our exact generated entries before a bundler applies its own export conditions. */
export const removeSiteAdminDependencyAliases = <T extends AliasEntries>(
    aliases: T,
    owned: Record<string, string>,
): T => {
    const isOwned = (key: string, value: unknown): boolean =>
        typeof value === 'string' && owned[key]?.replaceAll('\\', '/') === value.replaceAll('\\', '/')
    const result = (
        Array.isArray(aliases)
            ? aliases.filter((entry) => typeof entry.find !== 'string' || !isOwned(entry.find, entry.replacement))
            : Object.fromEntries(Object.entries(aliases).filter(([key, value]) => !isOwned(key, value)))
    ) as T
    assertSiteAdminDependencyAliasConflicts(result)
    return result
}

interface ResolverContext {
    resolve(
        id: string,
        importer?: string,
        options?: { skipSelf?: boolean },
    ): Promise<{ id: string; external?: boolean | 'absolute' | 'relative' } | null>
}

/** Vite, Vitest and Nitro/Rollup opt-in; the active bundler retains its native export conditions. */
export const createSiteAdminDependencyPlugin = (options: { aliases?: () => AliasEntries } = {}) => ({
    name: 'site-admin-owned-dependencies',
    enforce: 'pre' as const,
    // Bare SSR externals would be re-resolved from the consuming application at runtime.
    config() {
        return { ssr: { noExternal: Object.values(siteAdminDependencyModules) } }
    },
    configResolved(config: { resolve: { alias: AliasEntries; dedupe?: string[] } }) {
        assertSiteAdminDependencyAliasConflicts(config.resolve.alias)
        for (const [namespace, name] of Object.entries(siteAdminDependencyModules)) {
            if (config.resolve.dedupe?.includes(name)) {
                throw new Error(`[site-admin] Dependency namespace ${namespace} conflicts with resolve.dedupe ${name}.`)
            }
        }
    },
    async resolveId(this: ResolverContext, id: string) {
        const specifier = dependencySpecifier(id)
        if (!specifier) return null
        assertSiteAdminDependencyAliasConflicts(options.aliases?.())
        const result = await this.resolve(specifier, owner, { skipSelf: true })
        if (!result) throw new Error(`[site-admin] Cannot resolve owned dependency export ${id} (${specifier}).`)
        return result
    },
})

type ExportTarget = string | null | ExportTarget[] | { [condition: string]: ExportTarget }
const targets = (target: ExportTarget): string[] => {
    if (typeof target === 'string') return [target]
    if (!target) return []
    return Object.values(target).flatMap(targets)
}

const declarationPath = (path: string): string => {
    if (/\.d\.(?:ts|mts|cts)$/u.test(path)) return path
    const extension = /\.(?:js|mjs|cjs)$/u.exec(path)?.[0]
    if (!extension) return path
    const stem = path.slice(0, -extension.length)
    const declarations =
        extension === '.mjs' ? ['.d.mts', '.d.ts'] : extension === '.cjs' ? ['.d.cts', '.d.ts'] : ['.d.ts']
    return declarations.map((suffix) => stem + suffix).find(existsSync) ?? path
}

const dependencyManifest = (name: string): string => {
    let directory = dirname(resolveModulePath(name, { from: import.meta.url }))
    for (;;) {
        const path = resolve(directory, 'package.json')
        if (existsSync(path)) {
            const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: string }
            if (manifest.name === name) return path
        }
        const parent = dirname(directory)
        if (parent === directory) throw new Error(`[site-admin] Cannot find owned dependency manifest ${name}.`)
        directory = parent
    }
}

const ownedExportPaths = (conditions: string[]): Record<string, string> => {
    const paths: Record<string, string> = {}
    for (const [namespace, name] of Object.entries(siteAdminDependencyModules)) {
        const manifestPath = dependencyManifest(name)
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { exports: ExportTarget }
        const exports =
            manifest.exports &&
            typeof manifest.exports === 'object' &&
            !Array.isArray(manifest.exports) &&
            Object.keys(manifest.exports).some((key) => key.startsWith('.'))
                ? manifest.exports
                : { '.': manifest.exports }
        const root = dirname(manifestPath)
        const subpaths = new Set<string>()
        for (const [key, target] of Object.entries(exports)) {
            if (!key.includes('*')) {
                subpaths.add(key)
                continue
            }
            for (const pattern of targets(target)) {
                if (!pattern.startsWith('./') || !pattern.includes('*')) continue
                const [prefix, suffix = ''] = pattern.split('*')
                for (const file of globSync(pattern.replaceAll('*', '**/*'), { cwd: root })) {
                    const path = `./${file.replaceAll('\\', '/')}`
                    if (!path.startsWith(prefix!) || !path.endsWith(suffix)) continue
                    const match = path.slice(prefix!.length, suffix ? -suffix.length : undefined)
                    subpaths.add(key.replaceAll('*', match))
                }
            }
        }
        for (const subpath of subpaths) {
            const suffix = subpath === '.' ? '' : subpath.slice(1)
            const alias = namespace + suffix
            if (privateModuleIds.has(alias)) continue
            // Re-resolve even expanded wildcard candidates; blocked/conditional exports stay blocked.
            const path = resolveModulePath(name + suffix, { from: import.meta.url, conditions, try: true })
            if (path) paths[alias] = path
        }
    }
    return paths
}

/** Exact exported Node/Jiti aliases for configuration loaders and standalone tests. */
export const createSiteAdminDependencyAliases = (
    options: { conditions?: string[]; aliases?: AliasEntries; rootDir?: string } = {},
): Record<string, string> => {
    assertSiteAdminDependencyAliasConflicts(options.aliases)
    if (options.rootDir) {
        const manifest = resolve(options.rootDir, 'package.json')
        if (existsSync(manifest)) {
            const data = JSON.parse(readFileSync(manifest, 'utf8')) as { imports?: Record<string, unknown> }
            assertSiteAdminDependencyAliasConflicts(data.imports)
        }
    }
    return ownedExportPaths(options.conditions ?? ['node', 'import'])
}

/** Generate exact TypeScript paths from installed exports, including exported wildcard subpaths. */
export const createSiteAdminDependencyTypePaths = (
    options: { conditions?: string[]; paths?: Record<string, unknown> } = {},
): Record<string, string[]> => {
    assertSiteAdminDependencyAliasConflicts(options.paths)
    return Object.fromEntries(
        Object.entries(ownedExportPaths(['types', ...(options.conditions ?? ['node', 'import'])])).map(
            ([alias, path]) => [alias, [declarationPath(path)]],
        ),
    )
}
