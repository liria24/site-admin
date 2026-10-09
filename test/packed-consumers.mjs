import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyStandalone } from './standalone-consumer.mjs'
import { verifyOwnedDependencies } from './owned-dependency-consumer.mjs'
import { verifyPublicDataConsumer } from './public-data-consumer.mjs'
import { assertAiOmitted } from './assert-ai-omitted.mjs'
import { applyNuxt46VerificationPatch } from './nuxt-compatibility.ts'

const workspace = fileURLToPath(new URL('../', import.meta.url))
const packageManager = process.env.SITE_ADMIN_PACKAGE_MANAGER || 'bun'
if (!['bun', 'npm', 'pnpm'].includes(packageManager)) throw new Error('Unknown SITE_ADMIN_PACKAGE_MANAGER.')
const temporary = await mkdtemp(join(tmpdir(), 'site-admin-consumers-'))
const run = (command, args, cwd = temporary, env = process.env) => {
    console.log(`Consumer: ${command} ${args[0] ?? ''} (${cwd})`)
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env,
        shell: process.platform === 'win32' && ['npm', 'pnpm'].includes(command),
        maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.\n${result.stdout}\n${result.stderr}`)
    return result.stdout.trim()
}
const install = async (cwd = temporary, production = false) => {
    if (packageManager === 'npm') {
        // The fixture tests prereleases outside upstream stable peer ranges. Nitro emits a new manifest.
        const path = join(cwd, 'package.json')
        const manifest = JSON.parse(await readFile(path, 'utf8'))
        manifest.overrides = Object.fromEntries(
            ['vue', 'drizzle-orm'].filter((name) => manifest.dependencies?.[name]).map((name) => [name, `$${name}`]),
        )
        await writeFile(path, JSON.stringify(manifest))
        // npm cannot reify Nitro's traced links; install the generated production manifest into a clean tree.
        if (production) await rm(join(cwd, 'node_modules'), { force: true, recursive: true })
    }
    const result = run(
        packageManager,
        [
            'install',
            ...(production ? [packageManager === 'npm' ? '--omit=dev' : '--production'] : []),
            ...(packageManager === 'pnpm' ? ['--no-frozen-lockfile'] : []),
        ],
        cwd,
    )
    if (!production) await applyNuxt46VerificationPatch(cwd)
    return result
}
const exec = (args, cwd = temporary) =>
    run(
        packageManager,
        packageManager === 'bun'
            ? ['x', '--no-install', ...args]
            : ['exec', ...(packageManager === 'npm' ? ['--'] : []), ...args],
        cwd,
    )
const reservePort = () =>
    new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') return reject(new Error('Unable to reserve a test port.'))
            server.close((error) => (error ? reject(error) : resolve(address.port)))
        })
    })
const startNuxt = async (directory) => {
    const port = await reservePort()
    const output = []
    const child = spawn(process.execPath, [join(directory, '.output/server/index.mjs')], {
        cwd: directory,
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            NUXT_BETTER_AUTH_SECRET: 'packed-consumer-test-secret-000000000000000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => output.push(String(chunk)))
    child.stderr.on('data', (chunk) => output.push(String(chunk)))
    for (let attempt = 0; attempt < 400; attempt += 1) {
        if (child.exitCode !== null) break
        try {
            await fetch(`http://127.0.0.1:${port}/`)
            return { child, origin: `http://127.0.0.1:${port}`, output }
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }
    await stop(child)
    throw new Error(`Packed Nuxt consumer did not start.\n${output.join('')}`)
}
const stop = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    await once(child, 'exit')
}
const filesUnder = async (directory) => {
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) files.push(...(await filesUnder(path)))
        else files.push(path)
    }
    return files
}

try {
    let tarball = process.env.SITE_ADMIN_TARBALL ? resolvePath(process.env.SITE_ADMIN_TARBALL) : undefined
    if (!tarball) {
        run(
            'bun',
            ['pm', 'pack', '--destination', temporary, '--ignore-scripts'],
            join(workspace, 'packages/site-admin'),
        )
        const tarballName = (await readdir(temporary)).find((name) => name.endsWith('.tgz'))
        if (!tarballName) throw new Error('Package tarball was not created.')
        tarball = join(temporary, tarballName)
    }
    if (!(await stat(tarball)).isFile()) throw new Error('SITE_ADMIN_TARBALL must be a package file.')
    console.log(`Testing ${tarball} with ${packageManager}`)
    if (packageManager === 'npm') {
        await verifyStandalone(tarball)
        await verifyOwnedDependencies(tarball)
        await verifyPublicDataConsumer(tarball)
    }
    await Promise.all(['server', 'remote'].map((name) => mkdir(join(temporary, name), { recursive: true })))
    await writeFile(
        join(temporary, 'package.json'),
        JSON.stringify({
            dependencies: {
                '@liria24/site-admin': `file:${tarball.replaceAll('\\', '/')}`,
                '@better-auth/drizzle-adapter': '1.7.7',
                '@nuxtjs/better-auth': '0.3.7',
                '@tanstack/vue-form': '2.0.0-alpha.2',
                'drizzle-orm': '1.0.0-rc.4',
                'drizzle-kit': '1.0.0-rc.4',
                nuxt: '4.6.0',
                nitropack: '2.13.4',
                typescript: '7.0.2',
                vue: '3.6.0-rc.9',
            },
            private: true,
            type: 'module',
        }),
    )
    await writeFile(
        join(temporary, 'core.ts'),
        `import { defineSiteAdminConfig, image, text, type InferSiteAdminPublicModels } from '@liria24/site-admin'
import { createSiteAdminClient, managementAssetUrl, type PublicAsset } from '@liria24/site-admin/client'
import { createSiteAdmin } from '@liria24/site-admin/server'
const config = defineSiteAdminConfig({ models: { posts: { fields: { cover: image(), title: text({ required: true }) } } } })
const data = { title: 'Public', cover: { id: 'asset', url: '/api/content/_assets/asset' } } satisfies InferSiteAdminPublicModels<typeof config>['posts']['data']
const cover: PublicAsset = data.cover
if (managementAssetUrl(cover.id, '/manage/') !== '/manage/assets/asset/content') throw new Error('management asset helper invalid')
if (!config.models.posts || typeof createSiteAdmin !== 'function' || typeof createSiteAdminClient !== 'function') throw new Error('core exports missing')
`,
    )
    await writeFile(
        join(temporary, 'form.ts'),
        `import { useSiteAdminForm } from '@liria24/site-admin/form'
if (typeof useSiteAdminForm !== 'function') throw new Error('form export missing')
`,
    )
    await writeFile(
        join(temporary, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                module: 'Preserve',
                moduleResolution: 'Bundler',
                noEmit: true,
                skipLibCheck: true,
                strict: true,
                target: 'ES2024',
            },
            include: ['core.ts', 'form.ts'],
        }),
    )
    const disabled = `auth: false, i18n: false, llms: false, ogImage: false, robots: false, schemaOrg: false, seo: false, sitemap: false`
    await writeFile(
        join(temporary, 'server/nuxt.config.ts'),
        `import { defineNuxtConfig } from 'nuxt/config'
export default defineNuxtConfig({
  modules: ['@liria24/site-admin/nuxt'],
  i18n: { locales: ['en'], defaultLocale: 'en' },
  llms: { domain: 'http://localhost', title: 'Packed' },
})
`,
    )
    await writeFile(
        join(temporary, 'server/site-admin.config.ts'),
        `import { defineSiteAdminConfig, text } from '@liria24/site-admin'
export default defineSiteAdminConfig({ authorization: { roles: { user: {} } }, models: { posts: { fields: { title: text() } } } })
`,
    )
    await mkdir(join(temporary, 'server/app/components/OgImage'), { recursive: true })
    await writeFile(
        join(temporary, 'server/app/app.vue'),
        `<script setup>defineOgImage('Default.takumi')</script><template><div>packed server</div></template>`,
    )
    await writeFile(
        join(temporary, 'server/app/components/OgImage/Default.takumi.vue'),
        '<template><div style="display:flex;background:white;color:black;font-size:48px">Packed</div></template>',
    )
    const remoteOriginPort = await reservePort()
    const remoteOrigin = `http://127.0.0.1:${remoteOriginPort}`
    await writeFile(
        join(temporary, 'remote/nuxt.config.ts'),
        `import { defineNuxtConfig } from 'nuxt/config'
export default defineNuxtConfig({ modules: ['@liria24/site-admin/nuxt'], siteAdmin: { ${disabled}, client: { origin: ${JSON.stringify(remoteOrigin)} }, server: { enabled: false } } })
`,
    )
    await writeFile(
        join(temporary, 'remote/app.vue'),
        `<script setup>const route = useSiteAdminRoute()</script><template><div>{{ route?.entry?.data?.title || 'remote empty' }}</div></template>`,
    )

    await install()
    exec(['tsc', '--noEmit'])
    run(process.execPath, ['core.ts'])
    run(process.execPath, [
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs'; const meta = JSON.parse(readFileSync(new URL(import.meta.resolve('@liria24/site-admin/module.json')))); const pkg = JSON.parse(readFileSync(new URL(import.meta.resolve('@liria24/site-admin/package.json')))); if (meta.name !== pkg.name || meta.configKey !== 'siteAdmin' || meta.version !== pkg.version) throw new Error('Invalid module metadata')`,
    ])
    run(process.execPath, [
        '--input-type=module',
        '-e',
        `
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier.includes('drizzle')) throw new Error('Core imported Drizzle: ' + specifier)
  if (specifier === 'ai' || specifier.startsWith('ai/') || specifier.startsWith('@ai-sdk/') || specifier.startsWith('workers-ai-provider')) throw new Error('Core eagerly imported AI: ' + specifier)
  return next(specifier, context)
} })
await import('@liria24/site-admin')
await import('@liria24/site-admin/client')
await import('@liria24/site-admin/server')
await import('@liria24/site-admin/adapter')
for (const module of ['assets', 'content', 'document', 'plugins']) {
  try {
    import.meta.resolve('@liria24/site-admin/markdown/' + module)
    throw new Error('Internal Markdown module became a public export: ' + module)
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
}
`,
    ])
    run(process.execPath, ['form.ts'])
    run(process.execPath, [
        '--input-type=module',
        '-e',
        `
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'comark' || specifier.startsWith('comark/') || specifier.startsWith('markdown-exit') || specifier.startsWith('mdurl') || specifier.startsWith('linkify-it')) throw new Error('Form imported Markdown parser: ' + specifier)
  return next(specifier, context)
} })
await import('@liria24/site-admin/form')
`,
    ])
    exec(['site-admin', 'generate', '--config', 'server/site-admin.config.ts', '--out', 'server/schema.ts'])
    await writeFile(
        join(temporary, 'server/auth.config.ts'),
        `import { defineServerAuth } from '@nuxtjs/better-auth/config'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
export default defineServerAuth({
  database: drizzleAdapter({}, { provider: 'sqlite', usePlural: true, transaction: false }),
  emailAndPassword: { enabled: true },
})
`,
    )
    exec([
        'site-admin',
        'generate',
        '--config',
        'server/site-admin.config.ts',
        '--out',
        'server/schema.ts',
        '--auth',
        'server/auth.config.ts',
    ])
    await writeFile(
        join(temporary, 'server/drizzle.config.ts'),
        `export default { dialect: 'sqlite', schema: './schema.ts', out: './migrations', dbCredentials: { url: './.data/content.sqlite3' } }`,
    )
    await mkdir(join(temporary, 'server/.data'), { recursive: true })
    // Resolve the application's declared migration tool, never Site Admin's dependency directory.
    const kitBin = run(process.execPath, [
        '--input-type=module',
        '-e',
        `import {createRequire} from 'node:module'; import {dirname,join} from 'node:path'; const require=createRequire(import.meta.url); console.log(join(dirname(require.resolve('drizzle-kit')),'bin.cjs'))`,
    ])
    run(process.execPath, [kitBin, 'generate'], join(temporary, 'server'))
    run(process.execPath, [kitBin, 'migrate'], join(temporary, 'server'))
    await mkdir(join(temporary, 'server/server/plugins'), { recursive: true })
    await writeFile(join(temporary, 'server/server/auth.config.ts'), `export { default } from '../auth.config'`)
    await writeFile(
        join(temporary, 'server/app/auth.config.ts'),
        `import { defineClientAuth } from '@nuxtjs/better-auth/config'; export default defineClientAuth({})`,
    )
    await writeFile(
        join(temporary, 'server/server/plugins/database.ts'),
        `
import { useServerHooks } from 'nuxt/server'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'
import { drizzleAdapter as authAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import * as schema from '../../schema'
export default () => {
  const db = drizzle('./.data/content.sqlite3', { relations: schema.authRelations })
  const database = drizzleAdapter(db, { schema })
  const authDatabase = authAdapter(db, { provider: 'sqlite', schema, usePlural: true, transaction: false })
  useServerHooks().hook('site-admin:database', (context) => { context.database = database; context.authDatabase = authDatabase })
}
`,
    )
    await writeFile(
        join(temporary, 'server/server/types.ts'),
        `import { useServerHooks } from 'nuxt/server'
export default () => {
  useServerHooks().hook('site-admin:database', (context) => { const event = context.event; void event })
  useServerHooks().hook('site-admin:authorize', (context) => {
    const request: Request = context.event.req
    context.event.res.headers.set('x-native-probe', '1')
    // @ts-expect-error Native events do not expose Node.
    context.event.node
    // @ts-expect-error Use event.req; the legacy request alias is removed.
    context.request
    void request
  })
  // @ts-expect-error Unknown Site Admin hook.
  useServerHooks().hook('site-admin:missing', () => {})
}
const admin: ReturnType<typeof import('@liria24/site-admin/nuxt/server').useSiteAdmin> = useSiteAdmin()
void admin
`,
    )
    await writeFile(
        join(temporary, 'server/app/types.ts'),
        `const nativeSession = useUserSession()
const role: NonNullable<typeof nativeSession.user.value>['role'] = 'admin'
const impersonatedBy: NonNullable<typeof nativeSession.session.value>['impersonatedBy'] = 'test-admin'
// @ts-expect-error Native role inference must not degrade to any.
const invalidRole: NonNullable<typeof nativeSession.user.value>['role'] = 1
// @ts-expect-error Native session inference must retain its field type.
const invalidImpersonatedBy: NonNullable<typeof nativeSession.session.value>['impersonatedBy'] = 1
const client: import('@liria24/site-admin/client').SiteAdminClient = useSiteAdminClient()
const route = useSiteAdminRoute()
// @ts-expect-error No such public client method.
client.missing()
void route
void role
void impersonatedBy
void invalidRole
void invalidImpersonatedBy
`,
    )
    const setupNuxt = (dev) =>
        run(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { loadNuxt } from 'nuxt/kit'; const nuxt = await loadNuxt({ cwd: './server', dev: ${dev}, ready: true }); try { if (!nuxt.options.alias['#auth/server']?.endsWith('site-admin/better-auth-server-config.ts')) throw new Error('Native module ordering lost the Site Admin auth wrapper'); } finally { await nuxt.close() }`,
            ],
            temporary,
            {
                ...process.env,
                CI: 'true',
                AI_AGENT: '1',
                NUXT_BETTER_AUTH_SECRET: 'packed-consumer-test-secret-000000000000000',
            },
        )
    const manifestBefore = await readFile(join(temporary, 'package.json'), 'utf8')
    try {
        exec(['nuxt', 'build', 'server'])
        throw new Error('Missing renderer dependency was accepted.')
    } catch (error) {
        if (!/renderer missing dependencies|takumi renderer is not installed/u.test(String(error))) throw error
    }
    if ((await readFile(join(temporary, 'package.json'), 'utf8')) !== manifestBefore)
        throw new Error('Build mutated dependencies.')
    // Noninteractive builds require application-owned renderer dependencies.
    const consumer = JSON.parse(await readFile(join(temporary, 'package.json'), 'utf8'))
    Object.assign(consumer.dependencies, {
        '@takumi-rs/core': '^2.14.0',
        satori: '^0.33.5',
        '@resvg/resvg-js': '^2.6.2',
    })
    await writeFile(join(temporary, 'package.json'), JSON.stringify(consumer))
    await install()
    setupNuxt(true)
    setupNuxt(false)
    const nativeConfigPath = join(temporary, 'server/nuxt.config.ts')
    const nativeConfig = await readFile(nativeConfigPath, 'utf8')
    for (const modules of [
        "['@liria24/site-admin/nuxt', '@nuxtjs/better-auth']",
        "['@nuxtjs/better-auth', '@liria24/site-admin/nuxt']",
    ]) {
        await writeFile(nativeConfigPath, nativeConfig.replace("['@liria24/site-admin/nuxt']", modules))
        setupNuxt(false)
    }
    await writeFile(nativeConfigPath, nativeConfig)
    if (consumer.dependencies['nuxt-og-image'])
        throw new Error('Consumer should not need a direct OG module dependency.')
    const takumiPath = join(temporary, 'server/app/components/OgImage/Default.takumi.vue')
    const satoriPath = join(temporary, 'server/app/components/OgImage/Default.satori.vue')
    const template = await readFile(takumiPath, 'utf8')
    await rm(takumiPath)
    await writeFile(satoriPath, template)
    setupNuxt(true)
    setupNuxt(false)
    await writeFile(takumiPath, template)
    setupNuxt(false)
    await rm(satoriPath)
    exec(['nuxt', 'build', 'server'])
    await assertAiOmitted(join(temporary, 'server'))
    // CLI 4 relocates build artifacts; prepare restores the public generated type surface.
    exec(['nuxt', 'prepare', 'server'])
    for (const context of ['node', 'app', 'server'])
        exec(['tsc', '--noEmit', '-p', `server/.nuxt/tsconfig.${context}.json`])
    const serverFiles = await filesUnder(join(temporary, 'server/.output'))
    const serverBundle = (
        await Promise.all(serverFiles.map((file) => readFile(file).catch(() => Buffer.alloc(0))))
    ).join('\n')
    if (!serverBundle.includes('management-handler')) throw new Error('Default auth integration was not bundled.')
    for (const forbidden of ['devframe', '@nuxt/devtools-kit', '__site-admin-devtools']) {
        if (serverBundle.includes(forbidden))
            throw new Error(`Development-only code leaked into production server: ${forbidden}`)
    }
    // Drizzle ORM's comments mention Kit. Check the actual package/import, not documentation text.
    for (const file of serverFiles) {
        if (!(await stat(file)).isFile()) continue
        const source = String(await readFile(file))
        if (
            file.replaceAll('\\', '/').includes('/node_modules/drizzle-kit/') ||
            /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]drizzle-kit(?:\/|['"])/u.test(source)
        )
            throw new Error(`Generation-only Drizzle Kit leaked into production server: ${file}`)
    }
    await install(join(temporary, 'server/.output/server'), true)
    const local = await startNuxt(join(temporary, 'server'))
    try {
        const response = await fetch(`${local.origin}/api/content/posts`)
        const body = await response.text()
        if (!response.ok || body !== '[]') {
            throw new Error(
                `Packed server runtime probe failed (${response.status}): ${body}\n${local.output.join('')}`,
            )
        }
    } finally {
        await stop(local.child)
    }

    exec(['nuxt', 'build', 'remote'])
    const remoteFiles = await filesUnder(join(temporary, 'remote/.output'))
    const remoteContents = await Promise.all(
        remoteFiles.map(async (file) => [file, String(await readFile(file).catch(() => Buffer.alloc(0)))]),
    )
    for (const forbidden of [
        '@nuxtjs/better-auth',
        '@nuxtjs/i18n',
        '@nuxtjs/robots',
        '@nuxtjs/sitemap',
        'devframe',
        '@nuxt/devtools-kit',
        'drizzle-kit',
        'nuxt-og-image',
        'nuxt-schema-org',
        'site-admin.ai',
    ]) {
        const leaked = remoteContents.filter(([, content]) => content.includes(forbidden)).map(([file]) => file)
        if (leaked.length > 0) {
            throw new Error(`Disabled integration leaked into remote bundle: ${forbidden} in ${leaked.join(', ')}`)
        }
    }
    await install(join(temporary, 'remote/.output/server'), true)
    const publicServer = createServer((request, response) => {
        response.setHeader('content-type', 'application/json')
        if (request.url?.startsWith('/api/content/_route')) {
            response.end(
                JSON.stringify({
                    entry: { data: { title: 'Remote title' }, locale: '', model: 'posts', path: '/remote' },
                    kind: 'page',
                }),
            )
        } else response.end('{}')
    })
    await new Promise((resolve, reject) => {
        publicServer.once('error', reject)
        publicServer.listen(remoteOriginPort, '127.0.0.1', resolve)
    })
    const remote = await startNuxt(join(temporary, 'remote'))
    try {
        const response = await fetch(`${remote.origin}/remote`)
        const html = await response.text()
        if (!response.ok || !html.includes('Remote title')) {
            throw new Error(
                `Packed remote consumer runtime probe failed: ${response.status}\n${html.slice(0, 2000)}\n${remote.output.join('')}`,
            )
        }
    } finally {
        await stop(remote.child)
        await new Promise((resolve, reject) => publicServer.close((error) => (error ? reject(error) : resolve())))
    }
} catch (error) {
    console.error(error)
    throw error
} finally {
    await rm(temporary, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
}
