import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildNuxt, loadNuxt } from 'nuxt/kit'
import { generateSiteAdminSchema } from '../packages/site-admin/dist/generate.js'
import domain from './fixtures/nuxt-d1/site-admin.config.ts'

const run = promisify(execFile)
const workspace = fileURLToPath(new URL('../', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/nuxt-d1/', import.meta.url))
const wrangler = join(workspace, 'node_modules/wrangler/bin/wrangler.js')
const schemaPath = join(fixture, '.data/schema/schema.ts')
const migrations = join(fixture, '.data/migrations')
const wranglerConfig = join(fixture, '.data/wrangler.json')
const wranglerEnvironment = {
    ...process.env,
    WRANGLER_LOG_PATH: join(fixture, '.data/wrangler-logs'),
    WRANGLER_SEND_METRICS: 'false',
    XDG_CONFIG_HOME: join(fixture, '.data/wrangler-config'),
}
await Promise.all(
    ['.data', '.nuxt', '.output', '.wrangler'].map((name) => rm(join(fixture, name), { recursive: true, force: true })),
)
await mkdir(join(fixture, '.data/schema'), { recursive: true })
await writeFile(schemaPath, generateSiteAdminSchema(domain))
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
await writeFile(
    wranglerConfig,
    JSON.stringify({
        name: 'site-admin-nuxt-d1-test',
        main: '../.output/server/index.mjs',
        compatibility_date: '2026-10-08',
        compatibility_flags: ['nodejs_compat'],
        dev: { ip: '127.0.0.1', inspector_port: 0 },
        d1_databases: [
            {
                binding: 'DB',
                database_name: 'site-admin-nuxt-d1-test',
                database_id: '00000000-0000-4000-8000-000000000002',
                migrations_dir: './wrangler-migrations',
            },
        ],
        triggers: { crons: ['* * * * *'] },
    }),
)
await run(
    process.execPath,
    [
        wrangler,
        'd1',
        'migrations',
        'apply',
        'DB',
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
if (/createSQLiteDatabaseResolver|drizzle-orm\/node-sqlite|["']node:sqlite["']/u.test(workerSource))
    throw new Error('The D1 worker leaked the module-owned Node SQLite driver.')
const port = await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (!address || typeof address === 'string') return reject(new Error('Unable to reserve a test port.'))
        probe.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
})
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
const origin = `http://127.0.0.1:${port}`
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
    console.log('Standard Nuxt D1 connection, public content, manual task and native Cloudflare scheduled task passed.')
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
