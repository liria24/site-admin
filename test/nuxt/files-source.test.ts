import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineNuxtModule, hasNuxtModule, loadNuxt } from 'nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import filesModule from 'nuxt-files-sdk'
import { afterEach, expect, test } from 'vite-plus/test'

import {
    resolveSiteAdminFilesSource,
    siteAdminFilesModuleDependencies,
} from '../../packages/site-admin/src/nuxt/files-source'

const roots: string[] = []
const instances: Nuxt[] = []
afterEach(async () => {
    await Promise.all(instances.splice(0).map((nuxt) => nuxt.close()))
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (standalone = false) => {
    const root = await mkdtemp(resolve(tmpdir(), 'site-admin-files-source-'))
    roots.push(root)
    await writeFile(
        resolve(root, 'package.json'),
        JSON.stringify({ name: 'site-admin-files-probe', private: true, type: 'module' }),
    )
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), resolve(root, 'node_modules'), 'dir')
    for (const name of [
        'site-admin.config.ts',
        'inline-site.config.ts',
        'custom.ts',
        'top-level.ts',
        ...(standalone ? ['files.config.ts'] : []),
    ]) {
        await writeFile(
            resolve(root, name),
            `export default { storage: { adapter: 'memory', prefix: ${JSON.stringify(name)} } }`,
        )
    }
    return root
}

interface ProbeOptions {
    configFile: string
    enabled: boolean
}

const start = async (
    root: string,
    order: 'before' | 'after',
    kind: 'function' | 'package' | 'path',
    options: {
        filesInline?: string
        filesTopLevel?: string
        siteInline?: string
        siteTopLevel?: string
        installFiles?: boolean
        filesDisabled?: boolean
        siteDisabled?: boolean
    } = {},
) => {
    let source: string | undefined
    const siteModule = defineNuxtModule<ProbeOptions>({
        meta: { name: '@liria24/site-admin', configKey: 'siteAdmin' },
        defaults: { configFile: './site-admin.config.ts', enabled: true },
        moduleDependencies: siteAdminFilesModuleDependencies,
        async setup(config, nuxt) {
            if (!config.enabled) return
            source = await resolveSiteAdminFilesSource(nuxt, config.configFile)
        },
    })
    const sdk =
        kind === 'function'
            ? filesModule
            : kind === 'package'
              ? 'nuxt-files-sdk'
              : fileURLToPath(import.meta.resolve('nuxt-files-sdk'))
    const filesEntry = [
        sdk,
        { devtools: false, ...(options.filesInline ? { config: options.filesInline } : {}) },
    ] as unknown as Nuxt['options']['modules'][number]
    const siteEntry = [
        siteModule,
        {
            ...(options.siteInline ? { configFile: options.siteInline } : {}),
            ...(options.siteDisabled ? { enabled: false } : {}),
        },
    ] as unknown as Nuxt['options']['modules'][number]
    const modules =
        options.installFiles === false
            ? [siteEntry]
            : order === 'before'
              ? [filesEntry, siteEntry]
              : [siteEntry, filesEntry]
    const overrides = {
        modules,
        devtools: { enabled: false },
        telemetry: false as const,
        files: options.filesDisabled ? false : options.filesTopLevel ? { config: options.filesTopLevel } : {},
        siteAdmin: options.siteTopLevel ? { configFile: options.siteTopLevel } : {},
    }
    const nuxt = await loadNuxt({
        cwd: root,
        dev: false,
        ready: false,
        overrides,
    })
    instances.push(nuxt)
    await nuxt.ready()
    return { nuxt, source }
}

test.each(['function', 'package', 'path'] as const)(
    'native %s Files entries retain inline/top-level/fallback precedence in both module orders',
    async (kind) => {
        for (const order of ['before', 'after'] as const) {
            const root = await fixture()
            for (const options of [
                { filesInline: 'custom.ts', filesTopLevel: 'top-level.ts', expected: 'custom.ts' },
                { filesTopLevel: 'top-level.ts', expected: 'top-level.ts' },
                { expected: 'site-admin.config.ts' },
            ]) {
                const { nuxt, source } = await start(root, order, kind, options)
                expect(source).toBe(resolve(root, options.expected))
                const selected = await readFile(resolve(nuxt.options.buildDir, 'nuxt-files-sdk/selected.ts'), 'utf8')
                expect(selected).toContain(JSON.stringify(options.expected))
                await nuxt.close()
                instances.splice(instances.indexOf(nuxt), 1)
            }
        }
    },
)

test.each(['before', 'after'] as const)(
    'Files-first fallback and SiteAdmin inline configFile work with Files %s SiteAdmin',
    async (order) => {
        const standaloneRoot = await fixture(true)
        const standalone = await start(standaloneRoot, order, 'function', {
            siteInline: 'inline-site.config.ts',
            siteTopLevel: 'site-admin.config.ts',
        })
        expect(standalone.source).toBe(resolve(standaloneRoot, 'files.config.ts'))
        const commonRoot = await fixture()
        const common = await start(commonRoot, order, 'function', {
            siteInline: 'inline-site.config.ts',
            siteTopLevel: 'site-admin.config.ts',
        })
        expect(common.source).toBe(resolve(commonRoot, 'inline-site.config.ts'))
    },
)

test('optional Files defaults never install or activate Files by themselves', async () => {
    const root = await fixture()
    const { nuxt, source } = await start(root, 'before', 'function', { installFiles: false })
    expect(source).toBe(resolve(root, 'site-admin.config.ts'))
    expect(hasNuxtModule('nuxt-files-sdk', nuxt)).toBe(false)
})

test('optional Files defaults preserve an explicitly disabled Files module', async () => {
    const root = await fixture()
    const { nuxt } = await start(root, 'before', 'function', { filesDisabled: true })
    await expect(readFile(resolve(nuxt.options.buildDir, 'nuxt-files-sdk/selected.ts'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
    })
})

test('disabled SiteAdmin contributes no Files filename defaults', async () => {
    const root = await fixture()
    const { nuxt, source } = await start(root, 'before', 'function', { installFiles: false, siteDisabled: true })
    expect(source).toBeUndefined()
    expect((nuxt.options as typeof nuxt.options & { files?: unknown }).files).toEqual({})
})

test.each(['inline', 'top-level'] as const)(
    'missing explicit %s Files filename errors instead of falling back',
    async (choice) => {
        const root = await fixture(true)
        await expect(
            start(
                root,
                'after',
                'function',
                choice === 'inline' ? { filesInline: 'missing.ts' } : { filesTopLevel: 'missing.ts' },
            ),
        ).rejects.toThrow('Files configuration file does not exist')
    },
)
