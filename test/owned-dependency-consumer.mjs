import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { consumerDependencies } from './consumer-dependencies.mjs'

/** Exercise the real package manager, including a nested Nuxt postinstall. */
export async function verifyPeerDependencies(tarball, manager) {
    const directory = await mkdtemp(join(tmpdir(), 'site-admin-dependencies-'))
    const run = (command, args, env = process.env, failure = false) => {
        const result = spawnSync(command, args, {
            cwd: directory,
            encoding: 'utf8',
            env,
            shell: process.platform === 'win32' && ['npm', 'pnpm'].includes(command),
            maxBuffer: 16 * 1024 * 1024,
        })
        if (!failure && result.status !== 0) throw new Error(result.stdout + result.stderr)
        return result
    }
    const nuxt = ['node_modules/nuxt/bin/nuxt.mjs', 'prepare']
    const disabled =
        "auth: false, i18n: false, ai: false, markdown: false, seo: false, schemaOrg: false, sitemap: false, robots: false, llms: false, ogImage: false, server: { enabled: false }, client: { origin: 'https://content.example.invalid' }"
    const config = (i18n) =>
        "export default { modules: ['@liria24/site-admin/nuxt'], files: false, i18n: { locales: ['en'], defaultLocale: 'en' }, siteAdmin: { " +
        disabled.replace('i18n: false', 'i18n: ' + i18n) +
        ' } }'
    try {
        const version = run(manager, ['--version']).stdout.trim()
        const overrides = { vue: consumerDependencies(['vue']).vue, auth: '1.7.10' }
        await writeFile(
            join(directory, 'package.json'),
            JSON.stringify({
                name: 'site-admin-auto-dependencies',
                private: true,
                type: 'module',
                packageManager: manager + '@' + version,
                overrides,
                ...(manager === 'pnpm' ? { pnpm: { overrides } } : {}),
                scripts: { postinstall: 'nuxt prepare' },
                dependencies: {
                    '@liria24/site-admin': 'file:' + resolve(tarball).replaceAll('\\', '/'),
                    ...consumerDependencies(['nuxt', 'vue']),
                },
            }),
        )
        await writeFile(join(directory, 'nuxt.config.ts'), config(false))
        run(manager, ['install', '--ignore-scripts', ...(manager === 'pnpm' ? ['--no-frozen-lockfile'] : [])])
        run(process.execPath, nuxt, { ...process.env, CI: 'true' })
        await writeFile(join(directory, 'nuxt.config.ts'), config(true))
        const manifestBefore = await readFile(join(directory, 'package.json'), 'utf8')
        const lockName = manager === 'bun' ? 'bun.lock' : manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'
        const lockBefore = await readFile(join(directory, lockName), 'utf8')
        const ci = run(process.execPath, nuxt, { ...process.env, CI: 'true' }, true)
        assert.notEqual(ci.status, 0)
        assert.ok((ci.stdout + ci.stderr).includes('Missing dependencies: @nuxtjs/i18n'))
        assert.equal(await readFile(join(directory, 'package.json'), 'utf8'), manifestBefore)
        assert.equal(await readFile(join(directory, lockName), 'utf8'), lockBefore)
        run(process.execPath, nuxt, { ...process.env, CI: '' })
        const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        assert.ok(installed.dependencies['@nuxtjs/i18n'])
        assert.deepEqual(installed.overrides, overrides)
        for (const name of ['ai', 'comark', 'nuxt-og-image', '@nuxtjs/better-auth'])
            assert.equal(installed.dependencies[name], undefined)
        run(process.execPath, nuxt, { ...process.env, CI: 'true' })
        console.log(
            manager + ': automatic installation, disabled features, postinstall reentry and read-only CI passed.',
        )
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
}
