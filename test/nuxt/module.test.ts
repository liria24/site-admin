import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { $fetch, setup, getServerLogs, startServer, useTestContext, url } from '@nuxt/test-utils/e2e'
import { beforeAll, expect, it } from 'vitest'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
await mkdir(join(workspace, '.tmp'), { recursive: true })
const fixture = await mkdtemp(join(workspace, '.tmp/nuxt-module-'))
const lifecycleFile = `${fixture}-lifecycle.jsonl`
const config = (title: string) => `import { defineSiteAdminConfig, text } from '@liria24/site-admin'
import { required } from '#policy'
export default defineSiteAdminConfig({ models: { posts: { fields: { title: text({ required, default: ${JSON.stringify(title)} }) } } } })`
await mkdir(join(fixture, 'server/api'), { recursive: true })
await mkdir(join(fixture, 'app'), { recursive: true })
await writeFile(join(fixture, 'policy.ts'), 'export const required = true\n')
await writeFile(join(fixture, 'site-admin.config.ts'), config('Before'))
await writeFile(
    join(fixture, 'site-admin.ai.ts'),
    "import { defineSiteAdminAIConfig } from '@liria24/site-admin/ai'\nexport default defineSiteAdminAIConfig({ models: {} })\n",
)
await writeFile(
    join(fixture, 'nuxt.config.ts'),
    `import { defineNuxtConfig } from 'nuxt/config'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const trace = (scope: string, phase: string, name: string) => appendFileSync(${JSON.stringify(lifecycleFile)}, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, scope, phase, name }) + '\\n')
export default defineNuxtConfig({
  modules: [(options, nuxt) => {
    trace('nuxt', 'created', 'module')
    trace('nuxt', 'option', 'watcher:' + nuxt.options.experimental.watcher)
    nuxt.hook('vite:serverCreated', (server, context) => {
      const name = context.isClient ? 'client:close' : 'server:close'
      const close = server.close.bind(server)
      server.close = async () => {
        trace('vite', 'before', name)
        try { return await close() } finally { trace('vite', 'after', name) }
      }
    })
    nuxt.hooks.beforeEach(({ name }) => trace('nuxt', 'before', name))
    nuxt.hooks.afterEach(({ name }) => trace('nuxt', 'after', name))
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.beforeEach(({ name }) => trace('nitro', 'before', name))
      nitro.hooks.afterEach(({ name }) => trace('nitro', 'after', name))
    })
    nuxt.hook('site-admin:config', (config) => { nuxt.options.runtimeConfig.probe.title = String(config.models.posts?.fields.title?.default) }) }, '@liria24/site-admin/nuxt'],
  devtools: { enabled: false },
  alias: { '#policy': fileURLToPath(new URL('./policy.ts', import.meta.url)) },
  siteAdmin: { auth: false, i18n: false, llms: false, ogImage: false, robots: false, schemaOrg: false, seo: false, sitemap: false, routing: { enabled: false }, ai: {} },
  runtimeConfig: { probe: { title: '', generation: randomUUID() } },
})`,
)
await writeFile(join(fixture, 'app/app.vue'), '<template><div>module integration</div></template>')
await writeFile(
    join(fixture, 'server/api/probe.get.ts'),
    'export default defineEventHandler(() => useRuntimeConfig().probe)\n',
)
await writeFile(
    join(fixture, 'server/types.ts'),
    `import { useServerHooks } from 'nuxt/server'
export default () => {
  useServerHooks().hook('site-admin:database', (context) => {
    if (context.event) {
      const request: Request = context.event.req
      // @ts-expect-error Native events do not expose Node.
      context.event.node
      void request
    }
  })
  useServerHooks().hook('site-admin:authorize', (context) => { const id: string = context.actor.id; void id })
  // @ts-expect-error Unknown Site Admin hook.
  useServerHooks().hook('site-admin:missing', () => {})
}
const admin: ReturnType<typeof import('@liria24/site-admin/nuxt/server').useSiteAdmin> = useSiteAdmin()
void admin
`,
)
await writeFile(
    join(fixture, 'app/types.ts'),
    `const client: import('@liria24/site-admin/client').SiteAdminClient = useSiteAdminClient()
const route = useSiteAdminRoute()
// @ts-expect-error No such public client method.
client.missing()
void route
`,
)

await setup({
    rootDir: fixture,
    dev: true,
    build: true,
    server: false,
    browser: false,
    setupTimeout: 240_000,
    logLevel: 3,
})
// test-utils otherwise leaves its preparation dev build watching the same buildDir as the CLI.
// Close that instance before starting the CLI so only one builder writes generated files.
beforeAll(async () => {
    await useTestContext().nuxt!.close()
    await startServer()
}, 240_000)

it('delivers Vue component updates through the live Vite HMR connection', async () => {
    const client = await $fetch<string>('/_nuxt/@vite/client')
    const token = client.match(/const wsToken = "([^"]+)"/u)?.[1]
    expect(token, 'The Vite client must expose its local HMR connection token').toBeTruthy()
    const socketUrl = new URL('/_nuxt/', url('/'))
    socketUrl.protocol = 'ws:'
    socketUrl.searchParams.set('token', token!)
    const messages: Array<{ type: string; updates?: Array<{ path: string }> }> = []
    const socket = new WebSocket(socketUrl, 'vite-hmr')
    socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))))
    try {
        await expect.poll(() => messages.some(({ type }) => type === 'connected')).toBe(true)
        expect(await $fetch<string>('/_nuxt/app.vue')).toContain('module integration')
        await writeFile(join(fixture, 'app/app.vue'), '<template><div>component hot update</div></template>')
        await expect
            .poll(
                () =>
                    messages.some(
                        ({ type, updates }) =>
                            type === 'update' && updates?.some(({ path }) => path.includes('app.vue')),
                    ),
                { timeout: 20_000 },
            )
            .toBe(true)
        expect(await $fetch<string>('/_nuxt/app.vue')).toContain('component hot update')
        await expect.poll(async () => await $fetch<string>('/'), { timeout: 20_000 }).toContain('component hot update')
    } finally {
        socket.close()
    }
})

it('reloads aliased domain and AI config and exposes generated Nuxt/Nitro types', async () => {
    const before = await $fetch<{ title: string; generation: string }>('/api/probe')
    expect(before.title).toBe('Before')
    await writeFile(join(fixture, 'site-admin.config.ts'), config('After'))
    try {
        await expect
            .poll(async () => (await $fetch<{ title: string }>('/api/probe')).title, { timeout: 60_000, interval: 500 })
            .toBe('After')
    } catch (error) {
        throw new Error(`${await readFile(lifecycleFile, 'utf8')}\n${getServerLogs().join('\n')}`, { cause: error })
    }
    const after = await $fetch<{ generation: string }>('/api/probe')
    await writeFile(
        join(fixture, 'site-admin.ai.ts'),
        "import { defineSiteAdminAIConfig } from '@liria24/site-admin/ai'\nexport default defineSiteAdminAIConfig({ models: { posts: {} } })\n",
    )
    await expect
        .poll(
            async () => {
                try {
                    return (await $fetch<{ generation: string }>('/api/probe')).generation
                } catch {
                    return after.generation
                }
            },
            { timeout: 60_000, interval: 500 },
        )
        .not.toBe(after.generation)
    for (let reload = 2; reload <= 10; reload++) {
        const title = 'After ' + reload
        await writeFile(join(fixture, 'site-admin.config.ts'), config(title))
        try {
            await expect
                .poll(async () => (await $fetch<{ title: string }>('/api/probe')).title, {
                    timeout: 60_000,
                    interval: 500,
                })
                .toBe(title)
        } catch (error) {
            throw new Error(await readFile(lifecycleFile, 'utf8'), { cause: error })
        }
    }
    const activeBuilders = new Set<number>()
    for (const line of (await readFile(lifecycleFile, 'utf8')).trim().split('\n')) {
        const event = JSON.parse(line) as { pid: number; scope: string; phase: string; name: string }
        if (event.scope !== 'nuxt') continue
        if (event.phase === 'created') {
            expect(activeBuilders.size, 'Only one dev builder may write the fixture buildDir').toBe(0)
            activeBuilders.add(event.pid)
        } else if (event.name === 'close' && event.phase === 'after') {
            activeBuilders.delete(event.pid)
        }
    }
    expect(activeBuilders.size).toBe(1)
    const run = promisify(execFile)
    for (const context of ['node', 'app', 'server']) {
        try {
            await run(
                process.execPath,
                [
                    join(workspace, 'node_modules/typescript/bin/tsc'),
                    '--noEmit',
                    '-p',
                    join(fixture, `.nuxt/tsconfig.${context}.json`),
                ],
                { cwd: fixture },
            )
        } catch (error) {
            throw new Error(String((error as { stdout?: string }).stdout ?? error), { cause: error })
        }
    }
})
