import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { $fetch, setup, getServerLogs } from '@nuxt/test-utils/e2e'
import { expect, it } from 'vitest'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
await mkdir(join(workspace, '.tmp'), { recursive: true })
const fixture = await mkdtemp(join(workspace, '.tmp/nuxt-module-'))
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
import { fileURLToPath } from 'node:url'
export default defineNuxtConfig({
  modules: [(options, nuxt) => { nuxt.hook('site-admin:config', (config) => { nuxt.options.runtimeConfig.probe.title = String(config.models.posts?.fields.title?.default) }) }, '@liria24/site-admin/nuxt'],
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
    `export default defineNitroPlugin((app) => {
  app.hooks.hook('site-admin:database', (context) => { const event = context.event; void event })
  app.hooks.hook('site-admin:authorize', (context) => { const id: string = context.actor.id; void id })
  // @ts-expect-error Unknown Site Admin hook.
  app.hooks.hook('site-admin:missing', () => {})
})
const admin: ReturnType<typeof import('@liria24/site-admin/server').useSiteAdmin> = useSiteAdmin()
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

await setup({ rootDir: fixture, dev: true, browser: false, setupTimeout: 240_000, logLevel: 3 })

it('reloads aliased domain and AI config and exposes generated Nuxt/Nitro types', async () => {
    const before = await $fetch<{ title: string; generation: string }>('/api/probe')
    expect(before.title).toBe('Before')
    await writeFile(join(fixture, 'site-admin.config.ts'), config('After'))
    try {
        await expect
            .poll(async () => (await $fetch<{ title: string }>('/api/probe')).title, { timeout: 60_000, interval: 500 })
            .toBe('After')
    } catch (error) {
        throw new Error(getServerLogs().join('\n'), { cause: error })
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
