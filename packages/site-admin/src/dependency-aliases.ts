import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModulePath } from 'exsolve'

/** Deliberate consumer-facing namespaces, backed by Site Admin's own dependencies. */
export const siteAdminDependencyModules = {
    '#better-auth': 'better-auth',
    '#nuxtjs/better-auth': '@nuxtjs/better-auth',
    '#nuxt-files-sdk': 'nuxt-files-sdk',
    '#files-sdk': 'files-sdk',
    '#comark': 'comark',
    '#comark-content': 'comark-content',
    '#ai': 'ai',
} as const

// Small public contract, limited to consumer configuration and integration entrypoints.
const publicSubpaths: Record<keyof typeof siteAdminDependencyModules, readonly string[]> = {
    '#better-auth': ['', '/api', '/plugins', '/client', '/client/plugins', '/vue'],
    '#nuxtjs/better-auth': ['', '/config'],
    '#nuxt-files-sdk': ['', '/config', '/runtime'],
    '#files-sdk': ['', '/client', '/vue', '/memory', '/r2', '/fs'],
    '#comark': ['', '/parse', '/plugins/security', '/plugins/summary'],
    '#comark-content': ['', '/client'],
    '#ai': [''],
}
const publicSpecifiers = new Map(
    Object.entries(siteAdminDependencyModules).flatMap(([namespace, name]) =>
        publicSubpaths[namespace as keyof typeof publicSubpaths].map(
            (subpath) => [namespace + subpath, name + subpath] as const,
        ),
    ),
)

// These installed modules own exact private IDs inside otherwise public namespaces.
const privateModuleIds = new Set([
    '#better-auth/nitro-compat',
    '#better-auth/app-secret',
    '#nuxt-files-sdk/snapshot',
    '#nuxt-files-sdk/files',
])
const owner = fileURLToPath(import.meta.url)
type AliasEntries = Record<string, unknown> | ReadonlyArray<{ find: string | RegExp; replacement: string }>

const dependencySpecifier = (id: string): string | undefined => publicSpecifiers.get(id)

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
                          ...[...publicSpecifiers]
                              .filter(([id]) => id.startsWith(`${namespace}/`))
                              .flatMap(([id, specifier]) => [id, specifier]),
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

const declarationPath = (path: string): string => {
    if (/\.d\.(?:ts|mts|cts)$/u.test(path)) return path
    const extension = /\.(?:js|mjs|cjs)$/u.exec(path)?.[0]
    if (!extension) return path
    const stem = path.slice(0, -extension.length)
    const declarations =
        extension === '.mjs' ? ['.d.mts', '.d.ts'] : extension === '.cjs' ? ['.d.cts', '.d.ts'] : ['.d.ts']
    return declarations.map((suffix) => stem + suffix).find(existsSync) ?? path
}

const ownedExportPaths = (conditions: string[]): Record<string, string> => {
    const paths: Record<string, string> = {}
    for (const [alias, specifier] of publicSpecifiers) {
        const path = resolveModulePath(specifier, { from: import.meta.url, conditions, try: true })
        if (path) paths[alias] = path
    }
    return paths
}

/**
 * Export-resolved aliases for trusted configuration loaders and standalone tests.
 * Jiti treats alias keys as prefixes; only the curated names are public API.
 */
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

/** Resolve the curated public entries to their native declarations through package exports. */
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
