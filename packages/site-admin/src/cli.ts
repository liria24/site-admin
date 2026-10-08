#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createJiti } from 'jiti'
import type { SiteAdminConfig } from './config'
import { generateSiteAdminSchema, generateCombinedSchema } from './generate'
import { resolveSiteAdminConfig } from './config-resolution'
import { createSiteAdminDependencyAliases } from './dependency-aliases'
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
        'auth-use-plural': { type: 'boolean' },
        env: { type: 'string', multiple: true },
        prerender: { type: 'boolean', default: false },
    },
})
if (positionals.length !== 1 || positionals[0] !== 'generate')
    throw new Error(
        'Usage: site-admin generate [--config site-admin.config.ts] [--env production] [--prerender] [--auth server/auth.config.ts] [--auth-use-plural] [--out schema.ts]',
    )
const jiti = createJiti(import.meta.url, {
    alias: createSiteAdminDependencyAliases({ rootDir: process.cwd() }),
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
const auth = values.auth
    ? await jiti.import<NativeAuthConfig>(resolve(values.auth), {
          default: true,
      })
    : undefined
const source = auth
        ? await generateCombinedSchema(config, auth, {
              usePlural: values['auth-use-plural'] ?? false,
          })
        : generateSiteAdminSchema(config),
    output = resolve(values.out ?? 'schema.ts')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, source)
console.log(`Generated ${output}. Run drizzle-kit generate to create SQL migrations; no database was modified.`)
