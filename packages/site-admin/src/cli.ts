#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createJiti } from 'jiti'
import type { SiteAdminConfig } from './config'
import { generateSiteAdminSchema, generateCombinedSchema } from './generate'
import type { BetterAuthOptions } from 'better-auth'

type NativeAuthConfig =
    | BetterAuthOptions
    | ((context: { db: unknown; requestOrigin?: string; runtimeConfig: Record<string, unknown> }) => BetterAuthOptions)

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        config: { type: 'string', default: 'site-admin.config.ts' },
        out: { type: 'string', default: 'schema.ts' },
        auth: { type: 'string' },
        'auth-use-plural': { type: 'boolean', default: false },
    },
})
if (positionals.length !== 1 || positionals[0] !== 'generate')
    throw new Error(
        'Usage: site-admin generate [--config site-admin.config.ts] [--auth server/auth.config.ts] [--auth-use-plural] [--out schema.ts]',
    )
const config = await createJiti(import.meta.url, { fsCache: false }).import<SiteAdminConfig>(resolve(values.config), {
    default: true,
})
const auth = values.auth
    ? await createJiti(import.meta.url, { fsCache: false }).import<NativeAuthConfig>(resolve(values.auth), {
          default: true,
      })
    : undefined
const source = auth
        ? await generateCombinedSchema(config, auth, { usePlural: values['auth-use-plural'] })
        : generateSiteAdminSchema(config),
    output = resolve(values.out)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, source)
console.log(`Generated ${output}. Run drizzle-kit generate to create SQL migrations; no database was modified.`)
