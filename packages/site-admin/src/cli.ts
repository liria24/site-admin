#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createJiti } from 'jiti'
import type { SiteAdminConfig } from './config'
import { generateSiteAdminSchema, generateCombinedSchema } from './generate'
import { resolveSiteAdminConfig } from './config-resolution'
import type { BetterAuthOptions } from 'better-auth'

type NativeAuthConfig =
    | BetterAuthOptions
    | ((context: { db: unknown; requestOrigin?: string; runtimeConfig: Record<string, unknown> }) => BetterAuthOptions)

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        config: { type: 'string', default: 'site-admin.config.ts' },
        out: { type: 'string' },
        auth: { type: 'string' },
        env: { type: 'string', multiple: true },
        prerender: { type: 'boolean', default: false },
    },
})
if (positionals.length !== 1 || positionals[0] !== 'generate')
    throw new Error(
        'Usage: site-admin generate [--config site-admin.config.ts] [--env production] [--prerender] [--auth server/auth.config.ts] [--out schema.ts]',
    )
const jiti = createJiti(import.meta.url, {
    fsCache: false,
})
const loaded = await jiti.import<SiteAdminConfig>(resolve(values.config), {
    default: true,
})
const config = resolveSiteAdminConfig(loaded, [
    process.env.NODE_ENV ?? 'development',
    ...(values.env ?? []),
    ...(values.prerender ? ['prerender'] : []),
])
const nuxt = existsSync(resolve('nuxt.config.ts'))
    ? await (await import('nuxt/kit')).loadNuxtConfig({ cwd: process.cwd(), dotenv: false })
    : undefined
const authOptions = (
    nuxt as { auth?: { serverConfig?: string; schema?: Parameters<typeof generateCombinedSchema>[2] } } | undefined
)?.auth
const authFile =
    values.auth ??
    authOptions?.serverConfig ??
    (existsSync(resolve('server/auth.config.ts')) ? 'server/auth.config.ts' : undefined)
const auth = authFile
    ? await jiti.import<NativeAuthConfig>(resolve(authFile), {
          default: true,
      })
    : undefined
const source = auth ? await generateCombinedSchema(config, auth, authOptions?.schema) : generateSiteAdminSchema(config),
    output = resolve(values.out ?? config.schema?.output ?? 'db/schema.ts')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, source)
console.log(`Generated ${output}. Run void db generate to create SQL migrations; no database was modified.`)
