import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'
import { resolveModulePath } from 'exsolve'

/** Internal Nuxt integration context; the native module owns its runtime and Files export namespace. */
export interface NativeFilesIntegration {
    modulePath: string
    buildDir: string
    dev: boolean
    runtime?: boolean
}

export const ownedFilesImporter = (modulePath?: string): string =>
    pathToFileURL(modulePath ?? resolveModulePath('nuxt-files-sdk', { from: import.meta.url })).href

/** Exact published exports for trusted config loading, without evaluating providers or creating a registry. */
export const nativeFilesConfigAliases = (
    modulePath: string,
    conditions = ['node', 'import'],
): Record<string, string> => {
    const from = ownedFilesImporter(modulePath)
    const entry = resolveModulePath('files-sdk', { from, conditions: ['node', 'import'] })
    const manifest = findPackageJSON(pathToFileURL(entry))
    if (!manifest) throw new Error('[site-admin] Cannot locate the native Files SDK package exports.')
    const { exports } = JSON.parse(readFileSync(manifest, 'utf8')) as { exports: Record<string, unknown> }
    return Object.fromEntries(
        Object.keys(exports)
            .sort((a, b) => b.length - a.length)
            .map((key) => {
                if (key !== '.' && (!key.startsWith('./') || key.includes('*'))) {
                    throw new Error(`[site-admin] Unsupported native Files SDK export pattern: ${key}`)
                }
                const suffix = key === '.' ? '' : key.slice(1)
                return [`#files-sdk${suffix}`, resolveModulePath(`files-sdk${suffix}`, { from, conditions })]
            }),
    )
}

export const nativeFilesAliasTargets = (native: NativeFilesIntegration): Record<string, string[]> => {
    const node = nativeFilesConfigAliases(native.modulePath)
    const browser = nativeFilesConfigAliases(native.modulePath, ['browser', 'import'])
    const mode = native.dev ? '.dev' : ''
    return {
        ...Object.fromEntries(Object.entries(node).map(([name, path]) => [name, [path, browser[name]!]])),
        '#nuxt-files-sdk/registry': [resolve(native.buildDir, `nuxt-files-sdk/registry${mode}.mjs`)],
        'nuxt-files-sdk/runtime': [resolve(native.buildDir, `nuxt-files-sdk/runtime${mode}.mjs`)],
    }
}

export const isNativeFilesAlias = (key: string, value: unknown, targets: Record<string, string[]>): boolean =>
    typeof value === 'string' &&
    Boolean(targets[key]?.some((path) => path.replaceAll('\\', '/') === value.replaceAll('\\', '/')))
