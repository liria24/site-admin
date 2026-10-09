import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { join as joinPath } from 'pathe'
import { buildNuxt, loadNuxt } from 'nuxt/kit'
import { generateCombinedSchema } from '../packages/site-admin/dist/generate.js'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import domain from './fixtures/nuxt-d1/site-admin.config.ts'
import { assertNoNodeSQLiteDriver, verifyNodeSQLiteDriverCheck } from './fixtures/nuxt-d1/worker-imports.mjs'
import { assertAiOmitted } from './assert-ai-omitted.mjs'

verifyNodeSQLiteDriverCheck()
const run = promisify(execFile)
const workspace = fileURLToPath(new URL('../', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/nuxt-d1/', import.meta.url))
const wrangler = join(workspace, 'node_modules/wrangler/bin/wrangler.js')
const schemaPath = joinPath(fixture, '.data/schema/schema.ts')
const migrations = joinPath(fixture, '.data/migrations')
const wranglerConfig = join(fixture, '.data/wrangler.json')
const authSecret = 'site-admin-d1-integration-test-secret-0000000000000000'
const wranglerEnvironment = {
    ...process.env,
    WRANGLER_LOG_PATH: join(fixture, '.data/wrangler-logs'),
    WRANGLER_SEND_METRICS: 'false',
    XDG_CONFIG_HOME: join(fixture, '.data/wrangler-config'),
}
await Promise.all(
    // Nuxt recreates its module-install marker; each run must exercise clean native auth setup.
    ['.data', '.nuxt', '.output', '.wrangler', '.nuxtrc'].map((name) =>
        rm(join(fixture, name), { recursive: true, force: true }),
    ),
)
await mkdir(join(fixture, '.data/schema'), { recursive: true })
// Consumer-owned generation does not import its DB helper or open a connection.
await writeFile(
    schemaPath,
    await generateCombinedSchema(domain, {
        database: drizzleAdapter({}, { provider: 'sqlite', transaction: false }),
        emailAndPassword: { enabled: true },
    }),
)
await run(
    process.execPath,
    [
        join(workspace, 'packages/site-admin/node_modules/drizzle-kit/bin.cjs'),
        'generate',
        '--dialect=sqlite',
        `--schema=${schemaPath}`,
        `--out=${migrations}`,
    ],
    { cwd: fixture, timeout: 60_000, env: wranglerEnvironment },
)
const wranglerMigrations = join(fixture, '.data/wrangler-migrations')
await mkdir(wranglerMigrations, { recursive: true })
const migration = (await readdir(migrations)).find((name) => !name.startsWith('.'))
if (!migration) throw new Error('The consumer schema migration was not generated.')
await writeFile(
    join(wranglerMigrations, '0001_initial.sql'),
    await readFile(join(migrations, migration, 'migration.sql')),
)
const port = await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (!address || typeof address === 'string') return reject(new Error('Unable to reserve a test port.'))
        probe.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
})
const origin = `http://127.0.0.1:${port}`
process.env.NUXT_BETTER_AUTH_SECRET = authSecret
process.env.NUXT_PUBLIC_SITE_URL = origin
await writeFile(
    wranglerConfig,
    JSON.stringify({
        name: 'site-admin-nuxt-d1-test',
        main: '../.output/server/index.mjs',
        compatibility_date: '2026-10-08',
        compatibility_flags: ['nodejs_compat'],
        dev: { ip: '127.0.0.1', inspector_port: 0 },
        vars: { NUXT_BETTER_AUTH_SECRET: authSecret, NUXT_PUBLIC_SITE_URL: origin },
        d1_databases: [
            {
                binding: 'DB',
                database_name: 'site-admin-nuxt-d1-test',
                database_id: '00000000-0000-4000-8000-000000000002',
                migrations_dir: './wrangler-migrations',
            },
            {
                binding: 'ALT_DB',
                database_name: 'site-admin-nuxt-d1-alternate-test',
                database_id: '00000000-0000-4000-8000-000000000003',
                migrations_dir: './wrangler-migrations',
            },
        ],
        triggers: { crons: ['* * * * *'] },
    }),
)
for (const binding of ['DB', 'ALT_DB'])
    await run(
        process.execPath,
        [
            wrangler,
            'd1',
            'migrations',
            'apply',
            binding,
            '--local',
            '--config',
            wranglerConfig,
            '--persist-to',
            '.wrangler/state',
        ],
        { cwd: fixture, timeout: 60_000, env: wranglerEnvironment },
    )
const nuxt = await loadNuxt({ cwd: fixture, dev: false, ready: true })
try {
    await buildNuxt(nuxt)
} finally {
    await nuxt.close()
}
const sourceFiles = async (directory) => {
    const files = await readdir(directory, { withFileTypes: true })
    return (
        await Promise.all(
            files.map((file) =>
                file.isDirectory()
                    ? sourceFiles(join(directory, file.name))
                    : /\.[cm]?js$/u.test(file.name)
                      ? readFile(join(directory, file.name), 'utf8')
                      : '',
            ),
        )
    ).join('\n')
}
const workerSource = await sourceFiles(join(fixture, '.output/server'))
await assertAiOmitted(fixture)
assertNoNodeSQLiteDriver(workerSource)
if (workerSource.includes('node:sqlite'))
    console.log(
        'Better Auth includes a dormant SQLite fallback; no static Node SQLite or native Drizzle driver is bundled.',
    )
const output = []
const worker = spawn(
    process.execPath,
    [
        wrangler,
        'dev',
        '--local',
        '--test-scheduled',
        '--config',
        wranglerConfig,
        '--persist-to',
        '.wrangler/state',
        '--port',
        String(port),
    ],
    { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'], env: wranglerEnvironment },
)
worker.stdout.on('data', (chunk) => output.push(String(chunk)))
worker.stderr.on('data', (chunk) => output.push(String(chunk)))
const request = async (path, options) => {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(30_000), ...options })
    if (!response.ok) throw new Error(`D1 Nuxt request ${path} failed (${response.status}): ${await response.text()}`)
    return response.json()
}
try {
    let ready = false
    for (let attempt = 0; attempt < 300; attempt++) {
        if (worker.exitCode !== null) break
        try {
            ready = (await fetch(origin + '/', { signal: AbortSignal.timeout(1_000) })).ok
            if (ready) break
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (!ready) throw new Error('The local Nuxt D1 worker did not start.')
    const anonymousManagement = await fetch(origin + '/api/site-admin/models')
    if (
        anonymousManagement.status !== 401 ||
        (await anonymousManagement.json()).error?.code !== 'SITE_ADMIN_AUTH_REQUIRED'
    )
        throw new Error('The native D1 auth integration did not protect management routes.')
    if ((await request('/api/auth/get-session')) !== null)
        throw new Error('An anonymous D1 request unexpectedly received a session.')
    const signup = await fetch(origin + '/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email: 'd1@example.test', name: 'D1 user', password: 'synthetic-d1-test-password' }),
    })
    if (!signup.ok) throw new Error(`Native D1 signup failed: ${await signup.text()}`)
    const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ')
    const session = await request('/api/auth/get-session', { headers: { cookie } })
    if (session?.user?.email !== 'd1@example.test')
        throw new Error('The native D1 session did not match the signed-up user.')
    if (session.user.role !== 'user')
        throw new Error('The first native D1 signup did not retain the ordinary user role.')
    const alternateHeaders = { 'x-site-admin-test-database': 'alternate' }
    if ((await request('/api/auth/get-session', { headers: { cookie, ...alternateHeaders } })) !== null)
        throw new Error('A native auth session crossed from DB into ALT_DB.')
    const alternateSignup = await fetch(origin + '/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, ...alternateHeaders },
        body: JSON.stringify({
            email: 'd1-alternate@example.test',
            name: 'Alternate D1 user',
            password: 'synthetic-d1-test-password',
        }),
    })
    if (!alternateSignup.ok) throw new Error(`Native alternate D1 signup failed: ${await alternateSignup.text()}`)
    const alternateCookie = alternateSignup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ')
    const alternateSession = await request('/api/auth/get-session', {
        headers: { cookie: alternateCookie, ...alternateHeaders },
    })
    if (alternateSession?.user?.email !== 'd1-alternate@example.test')
        throw new Error('The native alternate D1 session did not use its request binding.')
    if ((await request('/api/auth/get-session', { headers: { cookie: alternateCookie } })) !== null)
        throw new Error('A native auth session crossed from ALT_DB into DB.')
    if ((await request('/api/auth/get-session', { headers: { cookie } }))?.user?.email !== 'd1@example.test')
        throw new Error('Selecting an alternate D1 binding changed the original request binding.')
    const database = await request('/api/__database')
    if (database.users !== 1 || Object.entries(database).some(([key, value]) => key !== 'users' && value !== true))
        throw new Error(`The shared D1 database/context identity probe failed: ${JSON.stringify(database)}`)
    const alternateDatabase = await request('/api/__database', { headers: alternateHeaders })
    if (
        alternateDatabase.users !== 1 ||
        Object.entries(alternateDatabase).some(([key, value]) => key !== 'users' && value !== true)
    )
        throw new Error(`The alternate D1 database/context probe failed: ${JSON.stringify(alternateDatabase)}`)
    const authenticatedManagement = await request('/api/site-admin/models', { headers: { cookie } })
    if (Object.keys(authenticatedManagement.models).length !== 0)
        throw new Error('The native D1 ordinary user unexpectedly received model permissions.')
    const forbiddenOperation = await fetch(origin + '/api/site-admin/entries?model=posts', { headers: { cookie } })
    if (forbiddenOperation.status !== 403)
        throw new Error('The first D1 signup unexpectedly received management permissions.')
    const unicodeSearch = await request('/api/__search', { method: 'POST' })
    if (
        unicodeSearch.status !== 200 ||
        unicodeSearch.data.total !== 1 ||
        unicodeSearch.data.items[0]?.data.title !== 'ΣΟΣ '.repeat(250) ||
        unicodeSearch.elapsed >= 2000
    )
        throw new Error(`Native D1 management Unicode search failed or was too slow: ${JSON.stringify(unicodeSearch)}`)
    const crossDatabaseManagement = await fetch(origin + '/api/site-admin/models', {
        headers: { cookie, ...alternateHeaders },
    })
    if (crossDatabaseManagement.status !== 401) throw new Error('A cross-database session received management access.')
    if (JSON.stringify(await request('/api/content/posts')) !== '[]')
        throw new Error('The explicit migration did not produce an empty public model.')
    const manual = await request('/api/__seed', { method: 'POST' })
    if (!manual.scheduledAt || JSON.stringify(await request('/api/content/posts')) !== '[]')
        throw new Error('The scheduled D1 revision became public before its task ran.')
    await new Promise((resolveWait) => setTimeout(resolveWait, 600))
    const task = await request('/api/__task', { method: 'POST' })
    if (!task.published?.includes(manual.id) || task.failed?.length)
        throw new Error(`The manual D1 publication task failed: ${JSON.stringify(task)}`)
    const published = await request('/api/content/posts')
    if (published[0]?.data?.title !== 'D1 manual runtime') throw new Error('The D1 public entry was not published.')
    const repeat = await request('/api/__task', { method: 'POST' })
    if (repeat.published?.length || repeat.failed?.length)
        throw new Error('Repeated task execution was not idempotent.')
    const scheduled = await request('/api/__seed?kind=scheduled', { method: 'POST' })
    await new Promise((resolveWait) => setTimeout(resolveWait, 600))
    const trigger = await fetch(origin + '/cdn-cgi/local/scheduled?format=json&cron=' + encodeURIComponent('* * * * *'))
    if (!trigger.ok || (await trigger.json()).outcome !== 'ok')
        throw new Error('The local Cloudflare scheduled task trigger failed.')
    let scheduledPublished = false
    for (let attempt = 0; attempt < 100; attempt++) {
        scheduledPublished = (await request('/api/content/posts')).some(
            (entry) => entry.data?.['_siteAdmin']?.id === scheduled.id,
        )
        if (scheduledPublished) break
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (!scheduledPublished) throw new Error('The Nitro Cloudflare task did not receive its native D1 binding.')
    const disabled = await fetch(origin + '/api/__task?task=gc', { method: 'POST' })
    if (disabled.ok) throw new Error('The destructive asset GC task was enabled without an opt-in.')
    await request('/api/auth/sign-out', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: '{}',
    })
    if ((await request('/api/auth/get-session', { headers: { cookie } })) !== null)
        throw new Error('The native D1 session remained valid after sign-out.')
    const signedOutManagement = await fetch(origin + '/api/site-admin/models', { headers: { cookie } })
    if (signedOutManagement.status !== 401) throw new Error('A signed-out D1 session retained management access.')
    if (
        (await request('/api/auth/get-session', { headers: { cookie: alternateCookie, ...alternateHeaders } }))?.user
            ?.email !== 'd1-alternate@example.test'
    )
        throw new Error('Signing out of DB invalidated the isolated ALT_DB session.')
    console.log(
        'Application-owned Nuxt D1 + Better Auth signup/session/logout, context isolation, public content and scheduled tasks passed.',
    )
} catch (error) {
    console.error(output.join(''))
    throw error
} finally {
    if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, 'exit')
        const forceExit = setTimeout(() => worker.kill('SIGKILL'), 5_000)
        worker.kill()
        await exited
        clearTimeout(forceExit)
    }
}
