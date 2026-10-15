import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Nuxt } from 'nuxt/schema'

const mocks = vi.hoisted(() => ({ installed: new Set<string>(), add: vi.fn(), install: vi.fn() }))
vi.mock('nuxt/kit', async (importOriginal) => ({
    ...(await importOriginal<typeof import('nuxt/kit')>()),
    ensureDependencyInstalled: async (names: string[]) => {
        const missing = names.filter((name) => !mocks.installed.has(name))
        return missing.length ? missing : true
    },
}))
vi.doMock(createRequire(new URL('../packages/site-admin/package.json', import.meta.url)).resolve('nypm'), () => ({
    addDependency: mocks.add,
    installDependencies: mocks.install,
}))
const { ensureSiteAdminDependencies } = await import('../packages/site-admin/src/nuxt/dependencies')
const roots: string[] = []
const fixture = async (dependencies = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'site-admin-dependency-test-'))
    roots.push(root)
    const project = {
        private: true,
        dependencies,
        overrides: { auth: '1.7.9' },
        patchedDependencies: { existing: 'existing.patch' },
    }
    await writeFile(join(root, 'package.json'), JSON.stringify(project))
    return { root, project, nuxt: { options: { rootDir: root, modulesDir: [] } } as unknown as Nuxt }
}
beforeEach(() => {
    vi.stubEnv('CI', '')
    mocks.installed.clear()
    mocks.add.mockReset()
    mocks.install.mockReset()
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('adds absent packages once and keeps the parent postinstall environment unchanged', async () => {
    const { root, nuxt, project } = await fixture()
    const previous = process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES
    mocks.add.mockImplementation(async (names, options) => {
        expect(names).toEqual(['comark@^0.7.0'])
        expect(options.cwd).toBe(root)
        expect(process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES).toBe(root)
        mocks.installed.add('comark')
    })
    await Promise.all([ensureSiteAdminDependencies(nuxt, ['comark']), ensureSiteAdminDependencies(nuxt, ['comark'])])
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(process.env.SITE_ADMIN_INSTALLING_DEPENDENCIES).toBe(previous)
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual(project)
})

it('installs declared requirements without rewriting their spec, overrides or patches', async () => {
    const { root, nuxt, project } = await fixture({ comark: 'workspace:*' })
    mocks.install.mockImplementation(async () => {
        mocks.installed.add('comark')
    })
    await ensureSiteAdminDependencies(nuxt, ['comark'])
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.install).toHaveBeenCalledWith({ cwd: root })
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual(project)
})

it('fails without writes in CI or a missing-dependency postinstall reentry', async () => {
    const { root, nuxt, project } = await fixture()
    vi.stubEnv('CI', 'true')
    await expect(ensureSiteAdminDependencies(nuxt, ['comark'])).rejects.toThrow('Missing dependencies: comark')
    vi.stubEnv('CI', '')
    vi.stubEnv('SITE_ADMIN_INSTALLING_DEPENDENCIES', root)
    await expect(ensureSiteAdminDependencies(nuxt, ['comark'])).rejects.toThrow('Missing dependencies: comark')
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual(project)
})

it('propagates installation failures and permits a later retry', async () => {
    const { nuxt } = await fixture()
    mocks.add.mockRejectedValueOnce(new Error('Synthetic package manager failure'))
    await expect(ensureSiteAdminDependencies(nuxt, ['comark'])).rejects.toThrow('Synthetic package manager failure')
    mocks.add.mockImplementationOnce(async () => {
        mocks.installed.add('comark')
    })
    await ensureSiteAdminDependencies(nuxt, ['comark'])
    expect(mocks.add).toHaveBeenCalledTimes(2)
})
