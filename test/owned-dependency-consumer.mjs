import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyNuxt46VerificationPatch } from './nuxt-compatibility.ts'

/** Strict packed consumer: only Site Admin owns the seven public dependency namespaces. */
export const verifyOwnedDependencies = async (tarball) => {
    const directory = await mkdtemp(join(tmpdir(), 'site-admin-owned-consumer-'))
    const run = (command, args, env = process.env) => {
        const result = spawnSync(command, args, {
            cwd: directory,
            encoding: 'utf8',
            env,
            shell: process.platform === 'win32' && command === 'npm',
            maxBuffer: 16 * 1024 * 1024,
        })
        if (result.status !== 0)
            throw new Error(`${command} ${args.join(' ')} failed.\n${result.stdout}\n${result.stderr}`)
        return result.stdout.trim()
    }
    const put = async (path, source) => {
        const destination = join(directory, path)
        await mkdir(resolve(destination, '..'), { recursive: true })
        await writeFile(destination, source)
    }
    let server
    const logs = []
    try {
        await put(
            'package.json',
            JSON.stringify({
                name: 'site-admin-owned-consumer',
                private: true,
                type: 'module',
                dependencies: {
                    '@liria24/site-admin': `file:${resolve(tarball).replaceAll('\\', '/')}`,
                    '@types/node': '26.6.4',
                    nuxt: '4.6.0',
                    typescript: '7.0.2',
                    vue: '3.6.0-rc.9',
                },
                overrides: { vue: '$vue' },
            }),
        )
        console.log('Owned consumer: isolated nested npm installation')
        run('npm', ['install', '--ignore-scripts', '--install-strategy=nested', '--no-audit', '--no-fund'])
        await applyNuxt46VerificationPatch(directory)
        await put(
            'check-owned.mjs',
            `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createSiteAdminDependencyAliases, createSiteAdminDependencyTypePaths, siteAdminDependencyModules } from '@liria24/site-admin/dependency-aliases'
const require = createRequire(import.meta.url)
for (const name of Object.values(siteAdminDependencyModules)) assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' })
const aliases = createSiteAdminDependencyAliases()
const paths = createSiteAdminDependencyTypePaths()
assert.equal(Object.keys(siteAdminDependencyModules).length, 7)
assert.equal(Object.keys(aliases).length, 24)
assert.deepEqual(Object.keys(paths), Object.keys(aliases))
assert.equal(aliases['#drizzle-orm'], undefined)
assert.equal(aliases['#drizzle-orm/sqlite-core'], undefined)
assert.equal(paths['#drizzle-orm'], undefined)
for (const id of ['#better-auth', '#better-auth/plugins', '#better-auth/client/plugins', '#nuxtjs/better-auth/config', '#nuxt-files-sdk/config', '#files-sdk/client', '#files-sdk/memory', '#comark/parse', '#comark-content/client', '#ai']) {
  assert.ok(aliases[id], id)
  assert.ok(paths[id], id)
}
for (const id of ['#better-auth/nitro-compat', '#better-auth/app-secret', '#nuxt-files-sdk/snapshot', '#nuxt-files-sdk/files']) assert.equal(aliases[id], undefined)
assert.equal(aliases['#comark/plugins/emoji'], undefined)
assert.equal(aliases['#comark/vue'], undefined)
assert.equal(aliases['#better-auth/dist/index.mjs'], undefined)
`,
        )
        run(process.execPath, ['check-owned.mjs'])
        await put(
            'nuxt.config.ts',
            `
import { defineNuxtConfig } from 'nuxt/config'
export default defineNuxtConfig({
  devtools: { enabled: false },
  modules: ['@liria24/site-admin/nuxt'],
  siteAdmin: { auth: false, i18n: false, llms: false, ogImage: false, robots: false, schemaOrg: false, seo: false, sitemap: false, routing: { enabled: false } },
})
`,
        )
        await put(
            'site-admin.config.ts',
            `
import { defineSiteAdminConfig, text } from '@liria24/site-admin'
import { defineFilesConfig } from '#nuxt-files-sdk/config'
import { parseMarkdown } from '#comark/parse'
import type { BetterAuthOptions } from '#better-auth'
import type { SiteAdminDatabase } from '@liria24/site-admin/adapter'
const files = defineFilesConfig({ storage: { adapter: 'memory' } })
const auth: Pick<BetterAuthOptions, 'emailAndPassword'> = { emailAndPassword: { enabled: true } }
void auth; void parseMarkdown
// Read-only empty protocol fixture, without an ORM, driver, connection or migration.
const database: SiteAdminDatabase = {
  dialect: 'sqlite',
  async query() { return [] },
  async atomic() { throw new Error('Owned consumer does not test database writes.') },
  bind() {
    return {
      revisionSource: 'owned_consumer_revisions',
      async assertSchema() {},
      insertRevisionData() { throw new Error('Owned consumer does not test revision writes.') },
    }
  },
}
export default defineSiteAdminConfig({
  ...files, assets: {},
  database,
  tasks: { publishDue: false, syncAssets: false, assetGC: false },
  models: { posts: { fields: { title: text({ required: true }) } } },
})
`,
        )
        await put(
            'server/auth.config.ts',
            `
import { defineServerAuth } from '#nuxtjs/better-auth/config'
import { username } from '#better-auth/plugins'
export default defineServerAuth({ emailAndPassword: { enabled: true }, plugins: [username()] })
`,
        )
        await put(
            'app/auth.config.ts',
            `
import { defineClientAuth } from '#nuxtjs/better-auth/config'
import { usernameClient } from '#better-auth/client/plugins'
export default defineClientAuth({ plugins: [usernameClient()] })
`,
        )
        await put(
            'app/app.vue',
            `
<script setup lang="ts">
import { createAuthClient } from '#better-auth/vue'
import { createFilesClient } from '#files-sdk/client'
import { parseMarkdown } from '#comark/parse'
const auth = createAuthClient()
const files = createFilesClient()
void auth; void files; void parseMarkdown
</script>
<template><main>Owned dependencies</main></template>
`,
        )
        await put(
            'server/api/owned.get.ts',
            `
import { memory } from '#files-sdk/memory'
import { createFiles } from '#files-sdk'
import { parseMarkdown } from '#comark/parse'
import { generateText } from '#ai'
import { defineEventHandler } from 'nuxt/server'
import { useSiteAdmin } from '@liria24/site-admin/nuxt/server'
export default defineEventHandler(async (event) => {
  const files = createFiles({ adapter: memory() })
  void files
  const parsed = await parseMarkdown('Owned dependencies')
  const siteAdmin = await useSiteAdmin(event)
  const entries = await siteAdmin.listPublicEntries('posts')
  return { owned: Boolean(parsed), ai: typeof generateText, models: Object.keys(siteAdmin.descriptor.models), empty: entries.length === 0 }
})
`,
        )
        await put(
            'standalone-types.ts',
            `
import type { BetterAuthOptions } from '#better-auth'
import { defineServerAuth } from '#nuxtjs/better-auth/config'
import { defineFilesConfig } from '#nuxt-files-sdk/config'
import { createFilesClient } from '#files-sdk/client'
import { parseMarkdown } from '#comark/parse'
import type { ContentClient } from '#comark-content/client'
import { generateText } from '#ai'
const auth: BetterAuthOptions = { emailAndPassword: { enabled: true } }
const files = defineFilesConfig({ storage: { adapter: 'memory' } })
void auth; void files; void defineServerAuth; void createFilesClient; void parseMarkdown; void generateText
export type ContentProbe = ContentClient
`,
        )
        await put(
            'write-types.mjs',
            `
import { writeFile } from 'node:fs/promises'
import { createSiteAdminDependencyTypePaths } from '@liria24/site-admin/dependency-aliases'
await writeFile('tsconfig.standalone.json', JSON.stringify({ compilerOptions: { target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, noEmit: true, paths: createSiteAdminDependencyTypePaths() }, files: ['standalone-types.ts'] }))
`,
        )
        console.log('Owned consumer: common config CLI and independent Node type paths')
        run(process.execPath, [
            'node_modules/@liria24/site-admin/dist/cli.js',
            'generate',
            '--out',
            '.generated/schema.ts',
        ])
        if (!(await readFile(join(directory, '.generated/schema.ts'), 'utf8')).includes('site_admin_content_posts')) {
            throw new Error('CLI did not load common hash-import configuration.')
        }
        run(process.execPath, ['write-types.mjs'])
        run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.standalone.json'])
        console.log('Owned consumer: Nuxt prepare and app/server/node projects')
        run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'prepare'])
        for (const project of ['app', 'server', 'node']) {
            run(process.execPath, [
                'node_modules/typescript/bin/tsc',
                '--noEmit',
                '-p',
                `.nuxt/tsconfig.${project}.json`,
            ])
        }
        console.log('Owned consumer: Nuxt production build')
        const env = { ...process.env, NUXT_BETTER_AUTH_SECRET: 'owned-consumer-test-secret-00000000000000000000' }
        run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'], env)
        const port = await new Promise((resolvePort, reject) => {
            const probe = createServer()
            probe.once('error', reject)
            probe.listen(0, '127.0.0.1', () => {
                const address = probe.address()
                if (!address || typeof address === 'string') return reject(new Error('No probe port.'))
                probe.close((error) => (error ? reject(error) : resolvePort(address.port)))
            })
        })
        server = spawn(process.execPath, ['.output/server/index.mjs'], {
            cwd: directory,
            env: { ...env, HOST: '127.0.0.1', PORT: String(port) },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        server.stdout.on('data', (chunk) => logs.push(String(chunk)))
        server.stderr.on('data', (chunk) => logs.push(String(chunk)))
        let response
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if (server.exitCode !== null) break
            try {
                response = await fetch(`http://127.0.0.1:${port}/api/owned`)
                break
            } catch {
                await new Promise((resolveWait) => setTimeout(resolveWait, 50))
            }
        }
        if (!response?.ok) throw new Error(`Owned runtime probe failed.\n${logs.join('')}`)
        const result = await response.json()
        if (!result.owned || result.ai !== 'function' || !result.models?.includes('posts') || result.empty !== true)
            throw new Error('Owned native server imports returned unexpected result.')
        const descriptorResponse = await fetch(`http://127.0.0.1:${port}/api/content/models`)
        const descriptor = descriptorResponse.ok ? await descriptorResponse.json() : undefined
        if (!descriptor?.models?.posts) throw new Error('Application-owned core adapter descriptor failed.')
        const entriesResponse = await fetch(`http://127.0.0.1:${port}/api/content/posts`)
        if (!entriesResponse.ok || JSON.stringify(await entriesResponse.json()) !== '[]') {
            throw new Error('Application-owned empty core adapter list failed.')
        }
        const page = await fetch(`http://127.0.0.1:${port}/`)
        if (!page.ok || !(await page.text()).includes('Owned dependencies')) {
            throw new Error('Owned client imports did not render the SSR page.')
        }
        console.log(
            'Owned dependency packed consumer passed: nested install, CLI, native types, Nuxt app/server/node, browser/server build and empty core-adapter runtime (auth sessions and database writes excluded).',
        )
    } finally {
        if (server && server.exitCode === null && server.signalCode === null) {
            server.kill()
            await once(server, 'exit')
        }
        await rm(directory, { recursive: true, force: true })
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const tarball = process.env.SITE_ADMIN_TARBALL ?? process.argv[2]
    if (!tarball) throw new Error('Pass a packed Site Admin tarball as argv[2] or SITE_ADMIN_TARBALL.')
    await verifyOwnedDependencies(tarball)
}
