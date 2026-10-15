import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ensureDependencyInstalled } from 'nuxt/kit'
import type { Nuxt, NuxtImport, ModuleDependencies } from 'nuxt/schema'
import { addDependency, installDependencies } from 'nypm'
import { siteAdminFilesModuleDependencies, siteAdminModuleOptions } from './files-source'
import type { ModuleOptions } from '../nuxt'
import { preparePresentation } from './presentation'

const prepared = new WeakSet<Nuxt>()
const pending = new Map<string, Promise<void>>()
let installing = Promise.resolve()
const installLocally = (root: string, action: () => Promise<unknown>) => {
    const task = installing
        .catch(() => {})
        .then(async () => {
            const previous = process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES
            process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES = root
            try {
                await action()
            } finally {
                if (previous === undefined) delete process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES
                else process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES = previous
            }
        })
    installing = task
    return task
}
const modules = {
    i18n: '@nuxtjs/i18n',
    schemaOrg: 'nuxt-schema-org',
    llms: 'nuxt-llms',
    seo: 'nuxt-seo-utils',
    sitemap: '@nuxtjs/sitemap',
    robots: '@nuxtjs/robots',
    ogImage: 'nuxt-og-image',
    auth: '@nuxtjs/better-auth',
} as const

/** Kit checks presence; explicit local installation follows Nuxt Content's native PM integration. */
export const ensureSiteAdminDependencies = async (nuxt: Nuxt, names: string[]) => {
    const root = nuxt.options.rootDir
    const previous = pending.get(root) ?? Promise.resolve()
    const task = previous
        .catch(() => {})
        .then(async () => {
            const check = () =>
                ensureDependencyInstalled(names, { rootDir: root, searchPaths: nuxt.options.modulesDir, prompt: false })
            const missing = await check()
            if (missing === true || missing.length === 0) return
            if (
                (process.env.CI && process.env.CI !== 'false') ||
                process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES === root
            )
                throw new Error(
                    '[site-admin] Missing dependencies: ' +
                        missing.join(', ') +
                        '. Install locally and commit package.json and the lockfile before CI.',
                )
            const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
                peerDependencies: Record<string, string>
                dependencies: Record<string, string>
            }
            const project = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as Record<
                string,
                Record<string, string> | undefined
            >
            const declared = {
                ...project.dependencies,
                ...project.devDependencies,
                ...project.peerDependencies,
                ...project.optionalDependencies,
            }
            const additions = missing
                .filter((name) => !declared[name])
                .map((name) => name + '@' + (manifest.peerDependencies[name] ?? manifest.dependencies[name]))
            await installLocally(root, () =>
                additions.length ? addDependency(additions, { cwd: root }) : installDependencies({ cwd: root }),
            )
            if ((await check()) !== true)
                throw new Error('[site-admin] Dependency installation did not resolve: ' + missing.join(', '))
        })
    pending.set(root, task)
    try {
        await task
    } finally {
        if (pending.get(root) === task) pending.delete(root)
    }
}

/** Runs before module graph setup and before common configuration imports providers. */
export const siteAdminModuleDependencies = async (nuxt: Nuxt): Promise<ModuleDependencies> => {
    const options = (await siteAdminModuleOptions(nuxt)) as ModuleOptions
    if (options.enabled === false) return {}
    if (options.auth !== false && !prepared.has(nuxt)) {
        prepared.add(nuxt)
        // Better Auth registers imports during modules:done, after Nuxt's first import scan.
        // Refresh the public Unimport context once all module setup hooks have completed.
        nuxt.hook('imports:context', (ctx) => {
            const stop = nuxt.hooks.afterEach(async ({ name }) => {
                if (name !== 'modules:done') return
                stop()
                await ctx.modifyDynamicImports(async (imports) => {
                    const additions: NuxtImport[] = []
                    await nuxt.callHook('imports:extend', additions)
                    for (const item of additions)
                        if (
                            !imports.some(
                                (existing) =>
                                    existing.name === item.name &&
                                    existing.as === item.as &&
                                    existing.from === item.from,
                            )
                        )
                            imports.push(item)
                })
            })
        })
    }
    const dependencies: ModuleDependencies = {}
    const names: string[] = []
    if (options.server?.enabled !== false) names.push('void', 'drizzle-orm')
    for (const [flag, name] of Object.entries(modules) as Array<[keyof typeof modules, string]>) {
        if (options[flag] === false || (flag === 'auth' && options.server?.enabled === false)) continue
        dependencies[name] = {}
        names.push(name)
    }
    if (options.auth !== false && options.server?.enabled !== false) names.push('better-auth')
    if (options.ai !== false) names.push('ai')
    if (options.markdown !== false) names.push('comark')
    if (options.ogImage !== false) names.push('@takumi-rs/core', '@takumi-rs/wasm')
    if ((nuxt.options as unknown as { files?: unknown }).files !== false) {
        names.push('files-sdk', 'nuxt-files-sdk')
    }
    if (
        ['schemaOrg', 'seo', 'sitemap', 'robots', 'ogImage'].some(
            (flag) => options[flag as keyof ModuleOptions] !== false,
        )
    ) {
        names.push('nuxt-site-config')
        dependencies['nuxt-site-config'] = {}
    }
    await ensureSiteAdminDependencies(nuxt, [...new Set(names)])
    if (options.i18n !== false && options.server?.enabled !== false) await preparePresentation(nuxt)
    return { ...dependencies, ...(await siteAdminFilesModuleDependencies(nuxt)) }
}
